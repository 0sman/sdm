const cds = require("@sap/cds/lib");
const { SELECT } = cds.ql;

async function getURLFromAttachments(keys, attachments) {
  return await SELECT.from(attachments, keys).columns("url");
}

async function getDraftAttachments(attachments, req) {
  const up_ = attachments.keys.up_.keys[0].$generatedFieldName;
  const idValue = up_.split("__")[1];
  const values = Object.values(attachments.elements)
    .filter(el => el.type != 'cds.Association' && el.type !== 'cds.Composition')
    .map(el => `${el.name} as "${el.name}"`)
  const fields = values.join(', ')
  const query = `
    SELECT ${fields}
    FROM ${attachments.drafts}
    WHERE ${up_} = '${req.data[idValue]}'
  `
  return await cds.run(query)
}

async function getFolderIdForEntity(attachments, req) {
  const up_ = attachments.keys.up_.keys[0].$generatedFieldName;
  const idValue = up_.split("__")[1];
  return await SELECT.from(attachments)
    .columns("folderId")
    .where({ [up_]: req.data[idValue] });
}

async function getDeletedAttachmentsIds(attachments, req) {
  const up_ = attachments.keys.up_.keys[0].$generatedFieldName;
  const idValue = up_.split("__")[1];
  const remainingAttachmentsIds = req.data.attachments.map(at => at.ID);
  
  let condition = { [up_]: req.data[idValue] }
  if (remainingAttachmentsIds.length > 0) {
    condition = { 
      [up_]: req.data[idValue],             
      ID: { 'NOT IN': remainingAttachmentsIds }
    }
  }
  const attachmentsToDeleteIds = await SELECT.from(attachments)
    .columns("ID")
    .where(condition);
    
  return attachmentsToDeleteIds.map(at => at.ID);
}

async function getURLsToDeleteFromAttachments(deletedAttachments, attachments) {
  return await SELECT.from(attachments)
    .columns("url")
    .where({ ID: { in: [...deletedAttachments] } });
}

async function getExistingAttachments(attachmentIDs, attachments) {
  return await SELECT("filename", "url", "ID","folderId")
    .from(attachments)
    .where({ ID: { in: [...attachmentIDs] }});
}

module.exports = {
  getDraftAttachments,
  getURLsToDeleteFromAttachments,
  getURLFromAttachments,
  getFolderIdForEntity,
  getExistingAttachments,
  getDeletedAttachmentsIds
};
