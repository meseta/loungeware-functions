const github = require("./github");
const airtable = require("./airtable");

exports.githubNotifier = github.notifier;
exports.airtableSyncLarolds = airtable.syncLarolds;
