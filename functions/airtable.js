const functions = require("firebase-functions");
const admin = require("firebase-admin");
const Airtable = require('airtable');

admin.initializeApp();
const laroldStore = admin.firestore().collection('Larolds');

Airtable.configure({
    endpointUrl: 'https://api.airtable.com',
    apiKey: functions.config().airtable.api_key
});
var base = Airtable.base(functions.config().airtable.base);

const runtimeOpts = {
  memory: "128MB",
};

async function doSync() {
  const records = await base('Larolds').select({
      view: "Grid view"
  }).all();

  functions.logger.info("Got larolds from airtable", {count: records.length});

  const documentReferences = await laroldStore.listDocuments()

  // Update IDs
  const updatedIds = (await Promise.all(records.map(async (record) => {
    const image = record.get('Image file');
    if (image.length == 0) return null;
  
    const id = image[0].id; // use the image unique ID as id
    await laroldStore.doc(id).set({
      name: record.get('Larold name'),
      attribution: record.get('Attribution name'),
      submitter: record.get('Submitter'),
      imageUrl: record.get('Image file')[0].url,
      confirmed: record.get('Confirmed for use') == 'Yes',
      modified: record.get('Last modified'),
    });
    return id;
  }))).filter((id) => !!id);

  functions.logger.info("Updated larolds in store", {updatedIds});

  // Remove old ones
  const deletedIds = (await Promise.all(documentReferences.map(async (doc) => {
    if(updatedIds.includes(doc.id)) return null;
  
    await doc.delete();
    return doc.id;
  }))).filter((id) => !!id);

  functions.logger.info("Removed larolds in store", {deletedIds});

  return {
    updated: updatedIds.length,
    deleted: deletedIds.length
  }
}

exports.syncLarolds = functions.runWith(runtimeOpts)
    .https.onRequest((request, response) => {
      return doSync().then(({updated, deleted}) => {
        functions.logger.info("Done sync", {updated, deleted});
        response.status(200).send(`Updated ${updated} Larolds, Deleted ${deleted}`);
      }).catch((err) => {
        functions.logger.error(err);
        response.status(500).send("Sync failed");
      });
    });

