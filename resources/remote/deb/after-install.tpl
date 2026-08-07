#!/bin/bash

if type update-alternatives >/dev/null 2>&1; then
    if [ -L '/usr/bin/${executable}' -a -e '/usr/bin/${executable}' -a "`readlink '/usr/bin/${executable}'`" != '/etc/alternatives/${executable}' ]; then
        rm -f '/usr/bin/${executable}'
    fi
    update-alternatives --install '/usr/bin/${executable}' '${executable}' '/opt/${sanitizedProductName}/${executable}' 100 || ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
else
    ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
fi

REMOTE_COMMAND='/usr/bin/agent-console-remote'
REMOTE_TARGET='/opt/${sanitizedProductName}/resources/remote/bin/agent-console-remote'
if [ ! -f "$REMOTE_TARGET" ] || [ -L "$REMOTE_TARGET" ]; then
    echo "Agent Console Remote launcher is missing from the package" >&2
    exit 1
fi
chmod 0755 "$REMOTE_TARGET"
if [ -e "$REMOTE_COMMAND" ] || [ -L "$REMOTE_COMMAND" ]; then
    if [ ! -L "$REMOTE_COMMAND" ]; then
        echo "Refusing to replace unrelated $REMOTE_COMMAND" >&2
        exit 1
    fi
    REMOTE_EXISTING=`readlink "$REMOTE_COMMAND"`
    if [ "$REMOTE_EXISTING" != '/etc/alternatives/agent-console-remote' ] && [ "$REMOTE_EXISTING" != "$REMOTE_TARGET" ]; then
        echo "Refusing to replace unrelated $REMOTE_COMMAND -> $REMOTE_EXISTING" >&2
        exit 1
    fi
fi
if type update-alternatives >/dev/null 2>&1; then
    update-alternatives --install "$REMOTE_COMMAND" 'agent-console-remote' "$REMOTE_TARGET" 100
else
    ln -s "$REMOTE_TARGET" "$REMOTE_COMMAND"
fi

if ! { [[ -L /proc/self/ns/user ]] && unshare --user true; }; then
    chmod 4755 '/opt/${sanitizedProductName}/chrome-sandbox' || true
else
    chmod 0755 '/opt/${sanitizedProductName}/chrome-sandbox' || true
fi

if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
fi

if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi

if apparmor_status --enabled > /dev/null 2>&1; then
  APPARMOR_PROFILE_SOURCE='/opt/${sanitizedProductName}/resources/apparmor-profile'
  APPARMOR_PROFILE_TARGET='/etc/apparmor.d/${executable}'
  if apparmor_parser --skip-kernel-load --debug "$APPARMOR_PROFILE_SOURCE" > /dev/null 2>&1; then
    cp -f "$APPARMOR_PROFILE_SOURCE" "$APPARMOR_PROFILE_TARGET"
    if ! { [ -x '/usr/bin/ischroot' ] && /usr/bin/ischroot; } && hash apparmor_parser 2>/dev/null; then
      apparmor_parser --replace --write-cache --skip-read-cache "$APPARMOR_PROFILE_TARGET"
    fi
  else
    echo "Skipping the installation of the AppArmor profile as this version of AppArmor does not seem to support the bundled profile"
  fi
fi
