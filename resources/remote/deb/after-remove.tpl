#!/bin/bash

if type update-alternatives >/dev/null 2>&1; then
    update-alternatives --remove '${executable}' '/opt/${sanitizedProductName}/${executable}'
else
    if [ -L '/usr/bin/${executable}' ] && [ "`readlink '/usr/bin/${executable}'`" = '/opt/${sanitizedProductName}/${executable}' ]; then
        rm -f '/usr/bin/${executable}'
    fi
fi

REMOTE_COMMAND='/usr/bin/agent-console-remote'
REMOTE_TARGET='/opt/${sanitizedProductName}/resources/remote/bin/agent-console-remote'
if type update-alternatives >/dev/null 2>&1; then
    update-alternatives --remove 'agent-console-remote' "$REMOTE_TARGET"
else
    if [ -L "$REMOTE_COMMAND" ] && [ "`readlink "$REMOTE_COMMAND"`" = "$REMOTE_TARGET" ]; then
        rm -f "$REMOTE_COMMAND"
    fi
fi

APPARMOR_PROFILE_DEST='/etc/apparmor.d/${executable}'
if [ -f "$APPARMOR_PROFILE_DEST" ]; then
  if apparmor_status --enabled > /dev/null 2>&1; then
    if ! { [ -x '/usr/bin/ischroot' ] && /usr/bin/ischroot; } && hash apparmor_parser 2>/dev/null; then
      apparmor_parser --remove "$APPARMOR_PROFILE_DEST" || true
    fi
  fi
  rm -f "$APPARMOR_PROFILE_DEST"
fi
