/**
 * Messenger, Instagram messaging and Facebook / Instagram comments over the Graph API (Page access token).
 *   DMs:            POST /{page-id}/messages  { recipient: { id }, messaging_type: RESPONSE, message }
 *   private reply:  POST /{page-id}/messages  { recipient: { comment_id }, message }   (once, within 7 days)
 *   FB comment:     POST /{comment-id}/comments { message };  hide: POST /{comment-id} { is_hidden: true }
 *   IG comment:     POST /{ig-comment-id}/replies { message }; hide: POST /{ig-comment-id} { hide: true }
 */
const { graph } = require("./graph");
const { pageToken } = require("./integration");

async function sendDm(i, recipientId, message, { humanAgent = false } = {}) {
  const tok = await pageToken(i);
  const body = { recipient: { id: recipientId }, message, ...(humanAgent ? { messaging_type: "MESSAGE_TAG", tag: "HUMAN_AGENT" } : { messaging_type: "RESPONSE" }) };
  const j = await graph(tok, "POST", `${i.meta.pageId}/messages`, { body });
  return j.message_id || "";
}
const sendDmText = (i, to, text, o) => sendDm(i, to, { text: String(text).slice(0, 2000) }, o);
// kind: image | video | audio | file
const sendDmMedia = (i, to, kind, url, o) => sendDm(i, to, { attachment: { type: kind, payload: { url, is_reusable: false } } }, o);

async function privateReply(i, commentId, text) {
  const tok = await pageToken(i);
  const j = await graph(tok, "POST", `${i.meta.pageId}/messages`, { body: { recipient: { comment_id: commentId }, message: { text: String(text).slice(0, 2000) } } });
  return j.message_id || "";
}

async function replyComment(i, channel, commentId, text) {
  const tok = await pageToken(i);
  const j = channel === "ig_comment" ? await graph(tok, "POST", `${commentId}/replies`, { body: { message: text } }) : await graph(tok, "POST", `${commentId}/comments`, { body: { message: text } });
  return j.id || "";
}

async function hideComment(i, channel, commentId, hide = true) {
  const tok = await pageToken(i);
  await graph(tok, "POST", commentId, { body: channel === "ig_comment" ? { hide } : { is_hidden: hide } });
  return true;
}

// The person's name / profile picture for a DM thread (best effort).
async function profileOf(i, channel, id) {
  try {
    const tok = await pageToken(i);
    const fields = channel === "instagram" ? "name,username,profile_pic" : "first_name,last_name,profile_pic";
    const j = await graph(tok, "GET", id, { query: { fields } });
    return { name: j.name || [j.first_name, j.last_name].filter(Boolean).join(" ") || j.username || "", handle: j.username ? `@${j.username}` : "", avatar: j.profile_pic || "" };
  } catch {
    return {};
  }
}

// Post / media details for a comment thread (best effort).
async function postOf(i, channel, id) {
  try {
    const tok = await pageToken(i);
    if (channel === "ig_comment") {
      const j = await graph(tok, "GET", id, { query: { fields: "permalink,caption,media_url,thumbnail_url,media_type" } });
      return { id, permalink: j.permalink || "", caption: (j.caption || "").slice(0, 300), thumbnail: j.thumbnail_url || j.media_url || "" };
    }
    const j = await graph(tok, "GET", id, { query: { fields: "permalink_url,message,full_picture" } });
    return { id, permalink: j.permalink_url || "", caption: (j.message || "").slice(0, 300), thumbnail: j.full_picture || "" };
  } catch {
    return { id };
  }
}

module.exports = { sendDm, sendDmText, sendDmMedia, privateReply, replyComment, hideComment, profileOf, postOf };
