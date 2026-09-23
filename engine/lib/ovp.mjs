/**
 * Raw Kaltura OVP HTTP calls used by deploy.mjs and teardown.mjs. Document
 * entries and short links have no management-SDK surface, so these go
 * straight to api_v3 the way the SDK itself would, all POST with format=1.
 */
const BASE = 'https://www.kaltura.com/api_v3/service';

async function apiForm(action, params) {
  const body = new URLSearchParams({ ...params, format: '1' });
  const resp = await fetch(`${BASE}/${action}`, { method: 'POST', body });
  const text = await resp.text();
  try { return JSON.parse(text); } catch { return text; }
}

async function apiMultipart(action, fields, file) {
  const form = new FormData();
  form.set('format', '1');
  for (const [k, v] of Object.entries(fields)) form.set(k, String(v));
  if (file) {
    const { readFileSync } = await import('node:fs');
    const buf = readFileSync(file.path);
    form.set(file.field, new Blob([buf], { type: file.type }), file.name);
  }
  const resp = await fetch(`${BASE}/${action}`, { method: 'POST', body: form });
  const text = await resp.text();
  try { return JSON.parse(text); } catch { return text; }
}

export async function uploadFile(ks, filePath, fileName, contentType) {
  const tokenResp = await apiForm('uploadToken/action/add', { ks, 'uploadToken[fileName]': fileName });
  if (!tokenResp?.id) throw new Error(`uploadToken/add failed for ${fileName}: ${JSON.stringify(tokenResp).slice(0, 300)}`);
  const uploadResp = await apiMultipart(
    'uploadToken/action/upload',
    { ks, uploadTokenId: tokenResp.id },
    { path: filePath, field: 'fileData', type: contentType, name: fileName },
  );
  if (uploadResp?.status !== 2) throw new Error(`uploadToken/upload failed for ${fileName}: ${JSON.stringify(uploadResp).slice(0, 300)}`);
  return { tokenId: tokenResp.id, size: uploadResp.uploadedFileSize };
}

/** documentType: 11 = PDF, 12 = HTML. Tries update first; falls through to create only on
 * ENTRY_ID_NOT_FOUND. updateContent replaces the file's bytes but never its stored name, so a
 * caller that passes a name carrying a version number (e.g. deploy.mjs's "<slug> - App vN") would
 * otherwise keep showing a stale name after every update. Rename right after a successful content
 * update, and check the rename response's id too, so a rename that silently lands on the wrong
 * entry is a thrown error, not a quiet mismatch. */
export async function updateOrCreateDocumentEntry(ks, entryId, tokenId, name, documentType) {
  if (entryId) {
    const updateResp = await apiMultipart('document_documents/action/updateContent', {
      ks, entryId, 'resource[objectType]': 'KalturaUploadedFileTokenResource', 'resource[token]': tokenId,
    });
    if (updateResp?.id === entryId) {
      const renameResp = await apiMultipart('baseEntry/action/update', {
        ks, entryId, 'baseEntry[objectType]': 'KalturaDocumentEntry', 'baseEntry[name]': name,
      });
      if (renameResp?.id !== entryId) {
        throw new Error(`Entry rename returned an unexpected id: ${JSON.stringify(renameResp).slice(0, 300)}`);
      }
      return { entryId, created: false };
    }
    if (updateResp?.code !== 'ENTRY_ID_NOT_FOUND') {
      throw new Error(`updateContent failed: ${JSON.stringify(updateResp).slice(0, 300)}`);
    }
  }
  const createResp = await apiMultipart('document_documents/action/addFromUploadedFile', {
    ks, 'documentEntry[name]': name, 'documentEntry[documentType]': String(documentType), uploadTokenId: tokenId,
  });
  if (!createResp?.id) throw new Error(`addFromUploadedFile failed: ${JSON.stringify(createResp).slice(0, 300)}`);
  return { entryId: createResp.id, created: true };
}

export async function deleteEntry(ks, entryId) {
  return apiForm('baseEntry/action/delete', { ks, entryId });
}

export async function findShortLinkBySystemName(ks, systemName) {
  const listResp = await apiMultipart('shortlink_shortlink/action/list', {
    ks, 'filter[systemNameEqual]': systemName, 'filter[statusEqual]': '2',
  });
  if (listResp?.totalCount > 0) return listResp.objects[0];
  return null;
}

export async function updateShortLink(ks, id, fullUrl) {
  const resp = await apiMultipart('shortlink_shortlink/action/update', {
    ks, id, 'shortLink[objectType]': 'KalturaShortLink', 'shortLink[fullUrl]': fullUrl,
  });
  if (!resp?.id) throw new Error(`Short link update failed: ${JSON.stringify(resp).slice(0, 300)}`);
  return resp;
}

export async function createShortLink(ks, systemName, fullUrl) {
  const resp = await apiMultipart('shortlink_shortlink/action/add', {
    ks,
    'shortLink[objectType]': 'KalturaShortLink',
    'shortLink[systemName]': systemName,
    'shortLink[fullUrl]': fullUrl,
    'shortLink[status]': '2',
  });
  if (!resp?.id) throw new Error(`Short link creation failed: ${JSON.stringify(resp).slice(0, 300)}`);
  return resp;
}

export async function deleteShortLink(ks, id) {
  return apiForm('shortlink_shortlink/action/delete', { ks, id });
}
