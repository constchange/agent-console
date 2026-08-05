## Editing and data reliability

- Replaced native JavaScript delete dialogs with an in-application two-step confirmation, preventing the Linux/Electron focus failure that could make editors appear unresponsive after deleting an Agent.
- Serialized every state save and gave each atomic write its own temporary file.
- Added a last-known-good backup, damaged-file preservation, and automatic backup recovery.
- Prevented older save responses from replacing newer optimistic changes in the interface.
- Added real Electron/X11 deletion-to-editing regression coverage.
- Replaced starter data with neutral Product, Sales, and Management examples.

Existing Projects, Agents, themes, and interface settings remain in place during the update.
