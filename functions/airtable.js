const functions = require("firebase-functions");
const admin = require("firebase-admin");
const Airtable = require("airtable");
const axios = require("axios");
const gm = require('gm').subClass({imageMagick: true});
const fs = require('fs').promises;
var path = require('path'); ;

admin.initializeApp();
const laroldStore = admin.firestore().collection("Larolds");
const bucket = admin.storage().bucket()

Airtable.configure({
  endpointUrl: "https://api.airtable.com",
  apiKey: functions.config().airtable.api_key,
});
const base = Airtable.base(functions.config().airtable.base);

const runtimeOpts = {
  memory: "128MB",
};

async function drawPalette() {
  const palettePath = `/tmp/palette.png`;

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

  return palettePath;
}

async function checkColors(file) {
  return new Promise((resolve, reject) => {
    gm(file).identify("%k", (err, colors) => {
      if (err) {
        reject(err);
      } else {
        resolve(colors);
      }
    })
  });
}

async function processImage(url, originalFilename, id) {
  const tempFileIn = `/tmp/in_${originalFilename}`;
  const tempFileOut = `/tmp/out_${originalFilename}`;

  // make palette  
  const palettePath = await drawPalette();


  // get file
  const res = await axios.get(url, { responseType: "arraybuffer" });
  await fs.writeFile(tempFileIn, res.data);

  // check colors
  const colors = await checkColors(tempFileIn);
  
  // do conversion
  await new Promise((resolve, reject) => {
    gm(tempFileIn)
      .resize(200, 200, '>')
      .in("-remap", palettePath)
      .write(tempFileOut, (err, stdout) => {
        if (err) {
          reject(err);
        } else {
          functions.logger.info("Processed image", {tempFileOut, stdout});
          resolve(stdout);
        }
      }
    );
  });

  // upload
  const destination = `larolds/${id}.png`;
  await bucket.upload(tempFileOut, {destination});

  // assemble warnings
  const warnings = [];
  if (colors != 2) {
    warnings.push(`Incorrect number of colors (${colors}) expeted 2`);
  }

  await fs.unlink(tempFileIn);
  await fs.unlink(tempFileOut);

  functions.logger.info("Uploaded image", {destination, warnings});
  return warnings;
}

/**
 *
 * @return {object} Larold records
 */
async function doSync() {
  const records = await base("Larolds").select({
    view: "Grid view",
  }).all();

  functions.logger.info("Got larolds from airtable", {count: records.length});

  const existingDocuments = await laroldStore.listDocuments();
  const existingData = Object.fromEntries(existingDocuments.map((doc) => [doc.id, doc.data]));

  // Update IDs
  const laroldData = {};
  const updatedIds = (await Promise.all(records.map(async (record, idx) => {
    const image = record.get("Image file");
    if (image.length == 0 || record.get("Confirmed for use") != "Yes") return null;

    const id = image[0].id; // use the image unique ID as id
    const modified = record.get("Last modified");
    const imageUrl = record.get("Image file")[0].url
    const originalFilename = record.get("Image file")[0].filename;
    const doc = {
      name: record.get("Larold name"),
      attribution: record.get("Attribution name"),
      submitter: record.get("Submitter"),
      imageUrl,
      modified,
      idx: idx+1,
      warnings: [],
    };

    // Check if updated
    if (!existingData[id] || existingData[id].modified != modified) {
      const warnings = await processImage(imageUrl, originalFilename, id);
      doc.warnings = warnings;
      await laroldStore.doc(id).set(doc);
    }
    laroldData[id] = doc;
    return id;
  }))).filter((id) => !!id);

  functions.logger.info("Updated larolds in store", {updatedIds});

  // Remove old ones
  const deletedIds = (await Promise.all(existingDocuments.map(async (doc) => {
    if (updatedIds.includes(doc.id)) return null;

    await doc.delete();
    return doc.id;
  }))).filter((id) => !!id);

  functions.logger.info("Removed larolds in store", {deletedIds});

  return laroldData;
}

exports.syncLarolds = functions.runWith(runtimeOpts)
    .https.onRequest((request, response) => {
      return doSync().then((laroldData) => {
        functions.logger.info("Done sync", {laroldData});
        response.status(200).json(laroldData);
      }).catch((err) => {
        functions.logger.error(err);
        response.status(500).send("Sync failed");
      });
    });

