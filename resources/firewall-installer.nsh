; Custom NSIS hooks for ADF Studio.
;
; Lives under resources/ (the electron-builder buildResources dir) so it is
; version-controlled — `build/` is gitignored and would not survive a clean CI
; checkout. Referenced explicitly via `nsis.include` in electron-builder.yml
; (named non-default so it is NOT also auto-included, which would double-define
; the macros).
;
; The installer already runs elevated, so this is the friction-free place to
; open the inbound firewall path that LAN discovery needs — no runtime UAC
; prompt for the common case. The runtime keeps its own elevated apply path
; (see src/main/services/firewall-service.ts) as a fallback for custom ports,
; users who declined at install, and dev builds that never run this installer.
;
; Two rules mirror the two network paths LAN discovery uses:
;   - TCP 7295 : peers fetch /mesh/directory (the "0 agents" failure if blocked)
;   - UDP 5353 : mDNS multicast discovery
;
; Rule names MUST match FW_RULE_TCP / FW_RULE_UDP in firewall-service.ts so the
; runtime check recognises installer-created rules and doesn't offer to re-add.
;
; Program-scoped to the installed binary, Private+Domain profiles only (never
; Public). Port is the 7295 default; a runtime that moved the mesh port repairs
; via the in-app apply path.

!macro customInstall
  DetailPrint "Adding firewall rules for LAN discovery..."
  ; Idempotent: delete any prior rule of the same name before adding.
  nsExec::Exec 'netsh advfirewall firewall delete rule name="ADF Mesh (LAN)"'
  nsExec::Exec 'netsh advfirewall firewall delete rule name="ADF mDNS (LAN)"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="ADF Mesh (LAN)" dir=in action=allow protocol=TCP localport=7295 program="$INSTDIR\${APP_EXECUTABLE_FILENAME}" profile=private,domain description="ADF Studio mesh directory + inbox (LAN peers)"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="ADF mDNS (LAN)" dir=in action=allow protocol=UDP localport=5353 program="$INSTDIR\${APP_EXECUTABLE_FILENAME}" profile=private,domain description="ADF Studio mDNS discovery"'
!macroend

!macro customUnInstall
  DetailPrint "Removing ADF Studio firewall rules..."
  nsExec::Exec 'netsh advfirewall firewall delete rule name="ADF Mesh (LAN)"'
  nsExec::Exec 'netsh advfirewall firewall delete rule name="ADF mDNS (LAN)"'
!macroend
