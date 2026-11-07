!macro NSIS_HOOK_PREINSTALL
  IfFileExists "$INSTDIR\uterm.exe" 0 +2
  SetFileAttributes "$INSTDIR\uterm.exe" NORMAL
  IfFileExists "$INSTDIR\licenses\uTerm-LICENSE.txt" 0 +2
  SetFileAttributes "$INSTDIR\licenses\uTerm-LICENSE.txt" NORMAL
  IfFileExists "$INSTDIR\licenses\uTerm-NOTICE.txt" 0 +2
  SetFileAttributes "$INSTDIR\licenses\uTerm-NOTICE.txt" NORMAL
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Protect the QA executable's embedded resources and license files during normal runtime.
  ; 在正常运行期间保护 QA 可执行文件内嵌资源和许可证文件。
  SetFileAttributes "$INSTDIR\uterm.exe" READONLY
  SetFileAttributes "$INSTDIR\licenses\uTerm-LICENSE.txt" READONLY
  SetFileAttributes "$INSTDIR\licenses\uTerm-NOTICE.txt" READONLY
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  IfFileExists "$INSTDIR\uterm.exe" 0 +2
  SetFileAttributes "$INSTDIR\uterm.exe" NORMAL
  IfFileExists "$INSTDIR\licenses\uTerm-LICENSE.txt" 0 +2
  SetFileAttributes "$INSTDIR\licenses\uTerm-LICENSE.txt" NORMAL
  IfFileExists "$INSTDIR\licenses\uTerm-NOTICE.txt" 0 +2
  SetFileAttributes "$INSTDIR\licenses\uTerm-NOTICE.txt" NORMAL
!macroend
