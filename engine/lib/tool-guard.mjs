/**
 * Refuses to create a Tool entity whose name already exists on this account
 * unless this project's own state already claims that exact id. Tools are
 * partner-level and shared by name, so this is the same collision guard as
 * every other named resource this engine creates (ARCHITECTURE.md 8).
 */
export async function assertNamedResourceFree(list, name, ourExistingId) {
  for await (const item of list) {
    if (item.name === name) {
      if (ourExistingId && String(item.id) === String(ourExistingId)) return item;
      throw new Error(ownedElsewhere(`"${name}"`, item.id));
    }
  }
  return null;
}

function ownedElsewhere(what, id) {
  return `${what} already exists on this account (id ${id}) and is not recorded in this project's own state. Refusing to create a duplicate or adopt a resource this project did not create.`;
}

/** Same guard for a knowledge category. Callers look it up only when the state file has no
 * category, so any match belongs to someone else. Uploading into it would mix this project's
 * entries into another project's corpus. */
export function categoryOwnedElsewhere(name, id) {
  return ownedElsewhere(`Knowledge category "${name}"`, id);
}
