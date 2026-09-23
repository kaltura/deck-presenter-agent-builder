Consent records for cloning a real person's voice or face.

Only needed when `project.json.avatar.source` will be `"cloned"`. A fresh,
synthetic avatar (`avatar.source: "fresh"`) needs no record here.

Before running the avatar provisioning step:

1. Copy `voice-consent.template.md` to `voice-<id>.md`, or
   `visual-consent.template.md` to `visual-<id>.md`, where `<id>` is the
   Kaltura voice or visual catalog id you are cloning from.
2. Fill in every field before running `provision`.
3. The engine refuses to run the clone path when the matching file is
   missing. It does not read the file's contents, so filling in every field
   is on you, not a check the engine makes for you.

Never commit a real person's name, contact detail, or likeness description to
a public repo. This directory is meant for a private, per-deck project repo.
