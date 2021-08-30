const functions = require("firebase-functions");
const octokit = require("@octokit/webhooks");
const axios = require("axios");

const webhooks = new octokit.Webhooks({
  secret: functions.config().github_webhook.secret,
});

const runtimeOpts = {
  memory: "128MB",
};

/**
 * Sends the discord webhook
 * @param {boolean} ping Whether to ping the crew
 * @param {string} author The name of the author
 * @param {string} icon Icon URL of the author
 * @param {string} heading Heading of the message
 * @param {(string|null)} title The title of the message
 * @param {(string|null)} body The body of the message
 * @param {string} url The url clicking on the embed goes to
 * @param {string} repo The repository
 * @return {Promise} axios promise
 */
function sendWebhook(ping, author, icon, heading, title, body, url, repo) {
  let content = null;
  if (ping) {
    content = "<@&863491966184325141>";
  }

  let fields = [];
  let description = null;
  if (!!title && !!body) {
    fields = [{
      "name": title,
      "value": body || "*No description provided*",
    }];
  } else if (body) {
    description = body;
  }

  const request = {
    "content": content,
    "username": "Larbot Gitrold",
    "avatar_url": "https://cdn.discordapp.com/attachments/862889240249892875/877721992931975168/unknown.png",
    "embeds": [{
      "color": 0xFFC89C,
      "author": {
        "name": author,
        "icon_url": icon,
      },
      "title": heading,
      "description": description,
      "fields": fields,
      "url": url,
      "footer": {
        "text": `Repository: ${repo}`,
      },
    }],
  };

  functions.logger.info("Sending discord webhook", {request});
  return axios.post(functions.config().discord_hook.url, request)
      .then((res) => {
        functions.logger.info("Discord webhook send successful", {res});
      }).catch((err) => {
        functions.logger.error("Discord webhook failed", {err});
      });
}

webhooks.on(["issues.opened", "issues.closed"], ({id, name, payload}) => {
  functions.logger.info("Handling Issue", {id, name, payload});

  let body;
  if (payload.action == "opened") {
    body = payload.issue.body;
  } else {
    if (payload.sender.login == payload.issue.user.login) {
      body = `*${payload.sender.login} ${payload.action} their own Issue*`;
    } else {
      body = `*${payload.sender.login} ${payload.action} ${payload.issue.user.login}'s Issue*`;
    }
  }

  sendWebhook(
      false,
      payload.sender.login,
      payload.sender.avatar_url,
      `Issue #${payload.issue.number} by ${payload.issue.user.login} ${payload.action}`,
      payload.issue.title,
      body,
      payload.issue.html_url,
      payload.repository.full_name,
  );
});

webhooks.on(["issue_comment.created"], ({id, name, payload}) => {
  functions.logger.info("Handling Issue Comment", {id, name, payload});
  sendWebhook(
      false,
      payload.comment.user.login,
      payload.comment.user.avatar_url,
      `Comment on Issue #${payload.issue.number} by ${payload.issue.user.login} ${payload.action}`,
      null,
      payload.comment.body,
      payload.comment.html_url,
      payload.repository.full_name,
  );
});

webhooks.on(
    ["pull_request.opened", "pull_request.reopened", "pull_request.closed"],
    ({id, name, payload}) => {
      functions.logger.info("Handling Pull Request", {id, name, payload});

      const action = payload.pull_request.merged ? "merged" : payload.action;
      let body;
      if (action == "opened") {
        body = payload.pull_request.body;
      } else {
        if (payload.sender.login == payload.pull_request.user.login) {
          body = `*${payload.sender.login} ${action} their own PR*`;
        } else {
          body = `*${payload.sender.login} ${action} ${payload.pull_request.user.login}'s PR*`;
        }
      }

      let ping = false;
      if ((payload.action == "opened" || payload.action == "reopened") && payload.pull_request.base.ref == "main") {
        ping = true;
      }

      sendWebhook(
          ping,
          payload.sender.login,
          payload.sender.avatar_url,
          `Pull Request #${payload.pull_request.number} by ${payload.pull_request.user.login} ${action}`,
          payload.pull_request.title,
          body,
          payload.pull_request.html_url,
          payload.repository.full_name,
      );
    },
);

webhooks.on(
    ["pull_request_review"],
    ({id, name, payload}) => {
      functions.logger.info("Handling Review", {id, name, payload});
      const action = payload.pull_request.merged ? "merged" : payload.action;
      let body;
      if (action == "opened") {
        body = payload.pull_request.body;
      } else {
        if (
          payload.sender.login == payload.review.user.login &&
          payload.sender.login == payload.pull_request.user.login
        ) {
          body = `*${payload.sender.login} ${action} their own review on their PR*`;
        } else if (payload.sender.login == payload.review.user.login) {
          body = `*${payload.sender.login} ${action} their review on ` +
                  `${payload.pull_request.user.login}'s PR*`;
        } else {
          body = `*${payload.sender.login} ${action} ${payload.review.user.login}'s ` +
                  `review on ${payload.pull_request.user.login}'s PR*`;
        }
      }

      sendWebhook(
          payload.action == "submitted" || payload.action == "dismissed",
          payload.sender.login,
          payload.sender.avatar_url,
          `Review on #${payload.pull_request.number} by ${payload.pull_request.user.login} ${payload.action}`,
          null,
          body,
          payload.review.html_url,
          payload.repository.full_name,
      );
    },
);

webhooks.on(
    ["release.published", "release.released"],
    ({id, name, payload}) => {
      functions.logger.info("Handling Release", {id, name, payload});
      sendWebhook(
          true,
          payload.sender.login,
          payload.sender.avatar_url,
          `Release ${payload.release.tag_name} ${payload.action}`,
          payload.release.name,
          payload.release.body,
          payload.release.html_url,
          payload.repository.full_name,
      );
    },
);

webhooks.onError((event) => {
  functions.logger.error("Error in event", event);
});

exports.notifier = functions.runWith(runtimeOpts)
    .https.onRequest((request, response) => {
      const event = request.headers["x-github-event"];
      const hook = {
        id: request.headers["x-github-delivery"],
        name: event,
        payload: request.rawBody.toString(),
        signature: request.headers["x-hub-signature-256"],
      };

      return webhooks.verifyAndReceive(hook).then(() => {
        response.status(200).send("Webhook handled");
      }).catch((err) => {
        functions.logger.error(err);
        response.status(500).send("Webhook not processed");
      });
    });

