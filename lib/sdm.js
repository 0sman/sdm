const cds = require("@sap/cds/lib");
const {
  getFolderIdByPath,
  createFolder,
  createAttachment,
  deleteAttachmentsOfFolder,
  deleteFolderWithAttachments,
  readAttachment,
  renameAttachment
} = require("../lib/handler");
const {
  fetchAccessToken,
  checkAttachmentsToRename,
} = require("./util/index");
const {
  getDraftAttachments,
  getURLsToDeleteFromAttachments,
  getURLFromAttachments,
  getFolderIdForEntity
} = require("../lib/persistence");
const { duplicateDraftFileErr, emptyFileErr, RenameErr, virusFileErr, duplicateFileErr } = require("./util/messageConsts");

module.exports = class SDMAttachmentsService extends (
  require("@cap-js/attachments/lib/basic")
) {
  init() {
    this.creds = this.options.credentials;
    return super.init();
  }
  getSDMCredentials() {
    return this.creds;
  }

  async get(attachments, keys, req) {
    const response = await getURLFromAttachments(keys, attachments);
    const token = await fetchAccessToken(
      this.creds,
      req.user.tokenInfo.getTokenValue()
    );
    try {
      const Key = response?.url;
      const content = await readAttachment(Key, token, this.creds);
      return content;
    } catch (error) {
      throw new Error(error);
    }
  }

  async draftSaveHandler(req) {
    const attachments = cds.model.definitions[req.query.target.name + ".attachments"];
    const attachment_val = await getDraftAttachments(attachments, req);

    if (attachment_val.length > 0) {
      await this.isFileNameDuplicateInDrafts(attachment_val,req);

      const token = await fetchAccessToken(
        this.creds,
        req.user.tokenInfo.getTokenValue()
      );
      const attachment_val_rename = attachment_val.filter(attachment => attachment.HasActiveEntity === true);
      const attachment_val_create = attachment_val.filter(attachment => attachment.HasActiveEntity === false);
      const attachmentIDs = attachment_val_rename.map(attachment => attachment.ID);
      let modifiedAttachments = [];

      modifiedAttachments = await checkAttachmentsToRename(attachment_val_rename, attachmentIDs, attachments)

      if(modifiedAttachments.length>0){
        await this.rename(modifiedAttachments, token, req)
      }
      if(attachment_val_create.length>0){
        await this.create(attachment_val_create, attachments, req, token)
      }
    }
  }
  async rename(modifiedAttachments, token, req){
    const failedReq = await this.onRename(
      modifiedAttachments,
      this.creds,
      token,
      req
    );
    let errorResponse = "";
    failedReq.forEach((attachment) => {
        attachment = attachment.replace("Child", RenameErr);
        errorResponse = errorResponse + "\n" + attachment;
    });
    if (errorResponse !== "") {
        req.warn(500, errorResponse);
    }
  }

  async create(attachment_val_create, attachments, req, token){
    let parentId = await this.getParentId(attachments,req,token)
    const failedReq = await this.onCreate(
      attachment_val_create,
      this.creds,
      token,
      attachments,
      req,
      parentId
    );
    let errorResponse = "";
    let virusFiles = [];
    let duplicateFiles = [];
    failedReq.forEach((attachment) => {
      if (attachment.typeOfError == 'virus') {
        virusFiles.push(attachment.name)
      }
      else{
        duplicateFiles.push(attachment.name)
      }
    });
    if(virusFiles.length != 0){
      errorResponse = virusFileErr(virusFiles)
    }
    if(duplicateFiles.length != 0){
      errorResponse = errorResponse + "\n" + duplicateFileErr(duplicateFiles);
    }
    if (errorResponse != ""){
      req.warn(500, errorResponse); 
    }
  }


  async  getParentId(attachments,req,token){
    const folderIds = await getFolderIdForEntity(attachments, req);
    let parentId = "";
    if (folderIds?.length == 0) {
      const folderId = await getFolderIdByPath(
        req,
        this.creds,
        token,
        attachments
      );
      if (folderId) {
        parentId = folderId;
      } else {
        const response = await createFolder(
          req,
          this.creds,
          token,
          attachments
        );
        parentId = response.data.succinctProperties["cmis:objectId"];
      }
    } else {
      parentId = folderIds ? folderIds[0].folderId : "";
    }
    return parentId;
  }

  async isFileNameDuplicateInDrafts(data,req) {
    let fileNames = [];
    for (let index in data) {
      fileNames.push(data[index].filename);
    }
    let duplicates = [
      ...new Set(
        fileNames.filter((value, index, self) => {
          return self.indexOf(value) !== index;
        })
      ),
    ];
    if (duplicates.length != 0) {
      req.reject(409, duplicateDraftFileErr(duplicates.join(", ")));
    }
  }

  async attachDeletionData(req) {
    const attachments =
      cds.model.definitions[req.query.target.name + ".attachments"];
    if (attachments) {
      const diffData = await req.diff();
      let deletedAttachments = [];
      diffData.attachments
        .filter((object) => {
          return object._op === "delete";
        })
        .map((attachment) => {
          deletedAttachments.push(attachment.ID);
        });
      if (deletedAttachments.length > 0) {
        const attachmentsToDelete = await getURLsToDeleteFromAttachments(
          deletedAttachments,
          attachments
        );
        if (attachmentsToDelete.length > 0) {
          req.attachmentsToDelete = attachmentsToDelete;
        }
      }
      if (req.event == "DELETE") {
        const token = await fetchAccessToken(
          this.creds,
          req.user.tokenInfo.getTokenValue()
        );
        const folderId = await getFolderIdByPath(
          req,
          this.creds,
          token,
          attachments
        );
        if (folderId) {
          req.parentId = folderId;
        }
      }
    }
  }

  async deleteAttachmentsWithKeys(records, req) {
    let failedReq = [],
      Ids = [];
    const token = await fetchAccessToken(
      this.creds,
      req.user.tokenInfo.getTokenValue()
    );
    if (req?.attachmentsToDelete?.length > 0) {
      if (req?.parentId) {
        await deleteFolderWithAttachments(this.creds, token, req.parentId);
      } else {
        const deletePromises = req.attachmentsToDelete.map(
          async (attachment) => {
            const deleteAttachmentResponse = await deleteAttachmentsOfFolder(
              this.creds,
              token,
              attachment.url
            );
            const delData = await this.handleRequest(
              deleteAttachmentResponse,
              attachment.url
            );
            if (delData && Object.keys(delData).length > 0) {
              failedReq.push(delData.message);
              Ids.push(delData.ID);
            }
          }
        );
        // Execute all promises
        await Promise.all(deletePromises);
        let removeCondition = (obj) => Ids.includes(obj.ID);
        req.attachmentsToDelete = req.attachmentsToDelete.filter(
          (obj) => !removeCondition(obj)
        );
        let errorResponse = "";
        failedReq.forEach((attachment) => {
          errorResponse = errorResponse + "\n" + attachment;
        });
        if (errorResponse != "") req.info(200, errorResponse);
      }
    } else {
      if (req?.parentId) {
        await deleteFolderWithAttachments(this.creds, token, req.parentId);
      }
    }
  }

  async onCreate(data, credentials, token, attachments, req, parentId) {
    let failedReq = [],
      Ids = [],
      success = [],
      success_ids = [];
    await Promise.all(
      data.map(async (d) => {
        // Check if d.content is null
        if (d.content === null) {
          failedReq.push(emptyFileErr(d.filename));
          Ids.push(d.ID);
        } else {
          const response = await createAttachment(
            d,
            credentials,
            token,
            attachments,
            parentId
          );
          if (response.status == 201) {
            d.folderId = parentId;
            d.url = response.data.succinctProperties["cmis:objectId"];
            d.content = null;
            success_ids.push(d.ID);
            success.push(d);
          } else {
            Ids.push(d.ID);
            if(response.response.data.message == 'Malware Service Exception: Virus found in the file!'){
              failedReq.push({typeOfError:'virus',name:d.filename})
            }
            else{
              failedReq.push({typeOfError:'duplicate',name:d.filename});
            }
          }
        }
      })
    );

    let removeCondition = (obj) => Ids.includes(obj.ID);
    req.data.attachments = req.data.attachments.filter(
      (obj) => !removeCondition(obj)
    );
    let removeSuccessAttachments = (obj) => success_ids.includes(obj.ID);

    // Filter out successful attachments
    req.data.attachments = req.data.attachments.filter(
      (obj) => !removeSuccessAttachments(obj)
    );

    // Add successful attachments to the end of the attachments array
    req.data.attachments = [...req.data.attachments, ...success];
    return failedReq;
  }

  async onRename(modifiedAttachments, credentials, token, req) {
    let emptyNameExists = modifiedAttachments.some(attachment => attachment.name === "");
    if(emptyNameExists) {
      throw new Error("Filename cannot be empty");
    }
    let failedReq = [];

    await Promise.all(
      modifiedAttachments.map(async (a) => {
        const response = await renameAttachment(
          a,
          credentials,
          token
        );

        if (response.status ==  undefined && response.response.status !=200) {
          //modify req.data.attachments
          for(let i = 0; i < req.data.attachments.length; i++) {
            let attachmentUpdate = req.data.attachments[i];
            if(a.ID == attachmentUpdate.ID){
              attachmentUpdate.filename = a.prevname;
              req.data.attachments[i] = attachmentUpdate;
            }
          }
          let message = response.response.data.message;
          if(message.includes(' with Id null')) {
            message = message.replace('with Id null', 'and Id '+a.url);
          }

          failedReq.push(message);
        }
      })
    );


    return failedReq;
  }

  async handleRequest(response, objectId) {
    let responseData = {},
      status = "";
    if (response.status != undefined) {
      status = response.status;
    } else status = response.response.status;
    switch (status) {
      case 404:
      case 200:
        break;
      default:
        responseData["ID"] = objectId;
        responseData["message"] = response.message;
        return responseData;
    }
  }
async getStatus() {
    return "Clean";
  }
  registerUpdateHandlers(srv, entity) {
    srv.before(
      ["DELETE", "UPDATE"],
      entity,
      this.attachDeletionData.bind(this)
    );
    srv.before("SAVE", entity, this.draftSaveHandler.bind(this));
    srv.after(
      ["DELETE", "UPDATE"],
      entity,
      this.deleteAttachmentsWithKeys.bind(this)
    );
  }
};
