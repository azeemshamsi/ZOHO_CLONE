// System emails (verification, password reset, invites) via the server's email settings.
const { sendSystemMail } = require("./mailer");

module.exports = function sendEmail(to, subject, text) {
  return sendSystemMail(to, subject, text);
};
