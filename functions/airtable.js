const functions = require("firebase-functions");
const admin = require("firebase-admin");
const Airtable = require("airtable");
const axios = require("axios");
const gm = require("gm").subClass({imageMagick: true});
const fs = require("fs").promises;
const JSZip = require("jszip");
const Mutex = require("async-mutex").Mutex;

admin.initializeApp();
const laroldStore = admin.firestore().collection("Larold");
const bucket = admin.storage().bucket();

Airtable.configure({
  endpointUrl: "https://api.airtable.com",
  apiKey: functions.config().airtable.api_key,
});
const base = Airtable.base(functions.config().airtable.base);

const runtimeOpts = {
  memory: "512MB",
};

const paletteMutex = new Mutex();

/**
 * Draws the palette used for remapping colors.
 * @return {string} path of palette file
 */
async function drawPalette() {
  const palettePath = "/tmp/palette.png";

  await paletteMutex.runExclusive(async () => {
    try {
      await fs.access(palettePath);
    } catch (error) {
      await new Promise((resolve, reject) => {
        gm(2, 1, "#1A1721FF")
            .fill("#FFC89C")
            .drawPoint(1, 0)
            .write(palettePath, (err, stdout) => {
              if (err) {
                reject(err);
              } else {
                functions.logger.info("Created palette file", {palettePath, stdout});
                resolve(stdout);
              }
            });
      });
    }
  });

  return palettePath;
}

/**
 * Counts the number of colors.
 * @param {string} file path to check colors of
 * @return {number} number of colors
 */
async function countColors(file) {
  return new Promise((resolve, reject) => {
    gm(file).identify("%k", (err, colors) => {
      if (err) {
        reject(err);
      } else {
        resolve(colors);
      }
    });
  });
}

/**
 * Process an image from a URL, and store in bucket storage.
 * @param {string} url of where to download image from
 * @param {string} originalFilename of image (used for file format hint)
 * @param {string} id
 * @return {object} warnings
 */
async function processImage(url, originalFilename, id) {
  const tempFileIn = `/tmp/${id}_${originalFilename}`;
  const tempFileOut = `/tmp/${id}.png`;

  // get file
  const res = await axios.get(url, {responseType: "arraybuffer"});
  await fs.writeFile(tempFileIn, res.data);
  functions.logger.info("Got file", {url, tempFileIn});

  // check colors
  const colors = await countColors(tempFileIn);

  // make palette
  const palettePath = await drawPalette();

  // do conversion
  await new Promise((resolve, reject) => {
    gm(tempFileIn)
        .resize(200, 200, ">")
        .in("-remap", palettePath)
        .write(tempFileOut, (err, stdout) => {
          if (err) {
            reject(err);
          } else {
            functions.logger.info("Processed image", {tempFileOut, stdout});
            resolve(stdout);
          }
        },
        );
  });

  // upload
  const destination = `larolds/${id}.png`;
  await bucket.upload(tempFileOut, {destination});

  // assemble warnings
  const warnings = [];
  if (colors != 2) {
    warnings.push(`Incorrect number of colors (${colors}) expected 2`);
  }

  await fs.unlink(tempFileIn);
  // await fs.unlink(tempFileOut); // might use this for cache

  functions.logger.info("Uploaded image", {destination, warnings});
  return {
    warnings,
    destination,
  };
}


/**
 * Make composite
 * @param {object[]} laroldData list of images in bucket to fetch
 * @return {buffer} buffer containing composite image in PNG
 */
async function makeComposite(laroldData) {
  // ensure images are downloaded
  const localPaths = await Promise.all(laroldData.map(async (doc) => {
    const localPath = `/tmp/${doc.id}.png`;
    try {
      await fs.access(localPath);
    } catch (error) {
      functions.logger.info("Downloading image", {destination: doc.destination});
      await bucket.file(doc.destination).download({destination: localPath});
    }
    return localPath;
  }));

  // montage
  return new Promise((resolve, reject) => {
    localPaths.slice(0, -1)
        .reduce((chain, localPath) => chain.montage(localPath), gm(localPaths[localPaths.length -1]))
        .geometry(200, 200)
        .in("-tile", "x1")
        .toBuffer("PNG", (err, buffer) => {
          if (err) {
            reject(err);
          } else {
            resolve(buffer);
          }
        },
        );
  });
}

/**
 * Synchronize larolds with the site
 * @return {object} Larold records
 */
async function doSync() {
  const records = await base("Larolds").select({
    view: "Grid view",
  }).all();

  functions.logger.info("Got larolds from airtable", {count: records.length});

  const existingDocuments = await laroldStore.listDocuments();
  const existingData = Object.fromEntries(existingDocuments.map((doc) => [doc.id, doc.data]));

  // Update image
  const laroldData = await Promise.all(records
      .filter((record) => (record.get("Image file").length > 0 && record.get("Confirmed for use") == "Yes"))
      .map(async (record, idx) => {
        const image = record.get("Image file")[0];
        const id = image.id; // use the image unique ID as id
        const modified = record.get("Last modified");

        // Check if updated
        let doc;
        if (!existingData[id] || existingData[id].modified != modified) {
          const imageUrl = image.url;
          const {warnings, destination} = await processImage(imageUrl, image.filename, id);
          doc = {
            imageUid: id,
            name: record.get("Larold name"),
            attribution: record.get("Attribution name"),
            submitter: record.get("Submitter"),
            imageUrl,
            modified,
            idx: idx+1,
            warnings,
            destination,
          };
          await laroldStore.doc(id).set(doc);
        } else {
          doc = existingData[id];
        }

        return doc;
      }));
  const updatedIds = laroldData.map((doc) => doc.id);
  functions.logger.info("Updated larolds in store", {updatedIds});

  // Remove old ones
  const deleteDocs = existingDocuments.filter((doc) => !updatedIds.includes(doc.id));
  const deletedIds = deleteDocs.map((doc) => doc.id);
  await Promise.all(deleteDocs.map((doc) => doc.delete()));

  functions.logger.info("Removed larolds in store", {deletedIds});

  // generate composite and zip
  const zip = new JSZip();
  zip.file("larolds.json", JSON.stringify(laroldData, null, 2));

  if (laroldData.length > 0) {
    const compositeBuffer = await makeComposite(laroldData);
    zip.file(`larolds_strip${laroldData.length}.png`, compositeBuffer, {binary: true});
  }

  functions.logger.info("Done sync", {laroldData});
  return zip.generateAsync({type: "nodebuffer"});
}

exports.syncLarolds = functions.runWith(runtimeOpts)
    .https.onRequest((request, response) => {
      return doSync().then((buffer) => {
        response.writeHead(200, {
          "Content-Type": "application/zip",
          "Content-disposition": "attachment; filename=larolds.zip",
        });
        response.end(buffer);
      }).catch((err) => {
        functions.logger.error(err);
        response.status(500).send("Sync failed");
      });
    });

