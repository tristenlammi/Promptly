; What the app itself may have written in HKCU. Kept when an update reinstalls over the top.
!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $UpdateMode <> 1
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Promptly Passwords"
    DeleteRegKey HKCU "Software\Google\Chrome\NativeMessagingHosts\org.promptly.passwords"
    DeleteRegKey HKCU "Software\Microsoft\Edge\NativeMessagingHosts\org.promptly.passwords"
    DeleteRegKey HKCU "Software\Chromium\NativeMessagingHosts\org.promptly.passwords"
    DeleteRegKey HKCU "Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\org.promptly.passwords"
    DeleteRegKey HKCU "Software\Vivaldi\NativeMessagingHosts\org.promptly.passwords"
    DeleteRegKey HKCU "Software\Mozilla\NativeMessagingHosts\org.promptly.passwords"
  ${EndIf}
!macroend
