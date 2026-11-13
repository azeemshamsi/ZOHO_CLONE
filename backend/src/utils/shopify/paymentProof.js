/**
 * Payment proof (UPI / bank screenshots) on a store order: kept in OrdexaGo (GridFS, like other attachments) and
 * sent to the Shopify order. Shopify's API doesn't let apps write timeline comments, so in Shopify the files go
 * to the order's "Payment proof" metafield (pinned, shown with thumbnails on the order page) and a line in the
 * order note with the link and payment reference.
 * Needs the write_files, read_files and write_orders scopes.
 */
const { gql } = require("./client");

const NS = "ordexago";
const KEY = "payment_proof";
const errs = (list) =>
  (list || [])
    .map((e) =>
      [(e.field || []).join("."), e.message].filter(Boolean).join(": "),
    )
    .join("; ");

async function ensureDefinition(store) {
  if (store.paymentProofDef) return;
  const d = await gql(
    store,
    `mutation($def: MetafieldDefinitionInput!) { metafieldDefinitionCreate(definition: $def) { createdDefinition { id } userErrors { field message code } } }`,
    {
      def: {
        name: "Payment proof",
        namespace: NS,
        key: KEY,
        type: "list.file_reference",
        ownerType: "ORDER",
        pin: true,
        description: "Payment screenshots added in OrdexaGo",
      },
    },
  );
  const ue = d.metafieldDefinitionCreate?.userErrors || [];
  if (
    ue.length &&
    !ue.some((e) => /TAKEN|taken|already/i.test(`${e.code} ${e.message}`))
  )
    throw new Error(`Shopify: ${errs(ue)}`);
  store.paymentProofDef = true;
  if (store.save) await store.save().catch(() => {});
}

// Upload bytes to Shopify Files; returns { id, url }.
async function uploadFile(store, { name, type, buf }) {
  const image = /^image\/(png|jpe?g|gif|webp|heic)/i.test(type);
  const st = await gql(
    store,
    `mutation($input: [StagedUploadInput!]!) { stagedUploadsCreate(input: $input) { stagedTargets { url resourceUrl parameters { name value } } userErrors { field message } } }`,
    {
      input: [
        {
          filename: name,
          mimeType: type || "application/octet-stream",
          resource: image ? "IMAGE" : "FILE",
          httpMethod: "POST",
          fileSize: String(buf.length),
        },
      ],
    },
  );
  const e1 = errs(st.stagedUploadsCreate?.userErrors);
  if (e1) throw new Error(`Shopify: ${e1}`);
  const t = st.stagedUploadsCreate.stagedTargets[0];
  const form = new FormData();
  for (const p of t.parameters) form.append(p.name, p.value);
  form.append(
    "file",
    new Blob([buf], { type: type || "application/octet-stream" }),
    name,
  );
  const up = await fetch(t.url, { method: "POST", body: form });
  if (!up.ok) throw new Error(`Shopify file upload failed (HTTP ${up.status})`);
  const fc = await gql(
    store,
    `mutation($files: [FileCreateInput!]!) { fileCreate(files: $files) { files { id fileStatus } userErrors { field message } } }`,
    {
      files: [
        {
          originalSource: t.resourceUrl,
          contentType: image ? "IMAGE" : "FILE",
          alt: `Payment proof ${name}`.slice(0, 500),
        },
      ],
    },
  );
  const e2 = errs(fc.fileCreate?.userErrors);
  if (e2) throw new Error(`Shopify: ${e2}`);
  const id = fc.fileCreate.files[0].id;
  // Shopify processes the file for a moment before its URL is known.
  let url = "";
  for (let i = 0; i < 8 && !url; i++) {
    await new Promise((r) => setTimeout(r, i ? 1500 : 800));
    const n = await gql(
      store,
      `query($id: ID!) { node(id: $id) { ... on MediaImage { fileStatus image { url } } ... on GenericFile { fileStatus url } } }`,
      { id },
    );
    if (n.node?.fileStatus === "FAILED")
      throw new Error("Shopify couldn't process the file");
    url = n.node?.image?.url || n.node?.url || "";
  }
  return { id, url };
}

// Send one proof to the Shopify order: file → metafield list, note line.
async function sendToShopify(store, order, { name, type, buf, reference, by }) {
  await ensureDefinition(store);
  const file = await uploadFile(store, { name, type, buf });
  const cur = await gql(
    store,
    `query($id: ID!) { order(id: $id) { note metafield(namespace: "${NS}", key: "${KEY}") { value } } }`,
    { id: order.shopifyId },
  );
  let ids = [];
  try {
    ids = JSON.parse(cur.order?.metafield?.value || "[]");
  } catch {
    ids = [];
  }
  const when = new Date().toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
  const line = `Payment proof (${when}${by ? `, ${by}` : ""}${reference ? `, ref ${reference}` : ""}): ${file.url || name}`;
  const note = [cur.order?.note, line].filter(Boolean).join("\n");
  const r = await gql(
    store,
    `mutation($input: OrderInput!) { orderUpdate(input: $input) { order { id } userErrors { field message } } }`,
    {
      input: {
        id: order.shopifyId,
        note,
        metafields: [
          {
            namespace: NS,
            key: KEY,
            type: "list.file_reference",
            value: JSON.stringify([...ids, file.id]),
          },
        ],
      },
    },
  );
  const e = errs(r.orderUpdate?.userErrors);
  if (e) throw new Error(`Shopify: ${e}`);
  return file;
}

module.exports = { sendToShopify, uploadFile, ensureDefinition };
