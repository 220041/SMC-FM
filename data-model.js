export const SCHEMA_VERSION = 2;

export function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter(v => typeof v === "string" && v.trim()).map(v => v.trim()))];
}

export function monthKeysForDates(dates) {
  return uniqueStrings(dates).filter(v => /^\d{4}-\d{2}-\d{2}$/.test(v)).map(v => v.slice(0, 7)).filter((v, i, a) => a.indexOf(v) === i);
}

export function archiveFields(actorName, actorUid) {
  return {
    archived: true,
    archivedBy: actorName,
    archivedByUid: actorUid || null,
    deleteRequestedBy: null,
    deleteRequestedByUid: null
  };
}

export function isRecordOwner(type, record, profile) {
  if (!record || !profile) return false;
  const uidField = type === "ticket" ? "requestedByUid" : type === "schedule" ? "registeredByUid" : "createdByUid";
  const nameField = type === "ticket" ? "requestedBy" : type === "schedule" ? "registeredBy" : "createdByName";
  if (record[uidField]) return record[uidField] === profile.uid;
  if (type === "memo" && !record[nameField]) return record.receivedBy === profile.name;
  return record[nameField] === profile.name;
}
