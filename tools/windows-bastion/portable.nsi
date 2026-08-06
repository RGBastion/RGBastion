!include "common.nsh"
!include "extractAppPackage.nsh"

# Custom portable launcher for Bastion.
# Stock electron-builder portable.nsi always RMDir + re-extracts (~500MB+) then
# deletes the unpack dir on exit — that alone causes ~60s cold starts.
# This variant extracts once into %LOCALAPPDATA%\<UNPACK_DIR_NAME>, skips extract
# when .bastion-portable-version matches ${VERSION}, and keeps files across runs.

CRCCheck off
WindowIcon Off
AutoCloseWindow True
RequestExecutionLevel ${REQUEST_EXECUTION_LEVEL}

Function .onInit
  !ifndef SPLASH_IMAGE
    SetSilent silent
  !endif

  !insertmacro check64BitAndSetRegView
FunctionEnd

Function .onGUIInit
  InitPluginsDir

  !ifdef SPLASH_IMAGE
    File /oname=$PLUGINSDIR\splash.bmp "${SPLASH_IMAGE}"
    BgImage::SetBg $PLUGINSDIR\splash.bmp
    BgImage::Redraw
  !endif
FunctionEnd

Section
  !ifdef SPLASH_IMAGE
    HideWindow
  !endif

  # Ephemeral fallback only if UNPACK_DIR_NAME was not defined (should not happen).
  StrCpy $INSTDIR "$PLUGINSDIR\app"
  !ifdef UNPACK_DIR_NAME
    StrCpy $INSTDIR "$LOCALAPPDATA\${UNPACK_DIR_NAME}"
  !endif

  StrCpy $R1 "1"
  IfFileExists "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 do_extract
  IfFileExists "$INSTDIR\.bastion-portable-version" 0 do_extract
  FileOpen $0 "$INSTDIR\.bastion-portable-version" r
  FileRead $0 $1
  FileClose $0
  # Strip trailing CR/LF from FileRead
  Push $1
  Call TrimNewlines
  Pop $1
  StrCmp $1 "${VERSION}" 0 do_extract
  StrCpy $R1 "0"

do_extract:
  StrCmp $R1 "0" skip_extract 0
  RMDir /r $INSTDIR
  SetOutPath $INSTDIR

  !ifdef APP_DIR_64
    !ifdef APP_DIR_ARM64
      !ifdef APP_DIR_32
        ${if} ${IsNativeARM64}
          File /r "${APP_DIR_ARM64}\*.*"
        ${elseif} ${RunningX64}
          File /r "${APP_DIR_64}\*.*"
        ${else}
          File /r "${APP_DIR_32}\*.*"
        ${endIf}
      !else
        ${if} ${IsNativeARM64}
          File /r "${APP_DIR_ARM64}\*.*"
        ${else}
          File /r "${APP_DIR_64}\*.*"
        ${endIf}
      !endif
    !else
      !ifdef APP_DIR_32
        ${if} ${RunningX64}
          File /r "${APP_DIR_64}\*.*"
        ${else}
          File /r "${APP_DIR_32}\*.*"
        ${endIf}
      !else
        File /r "${APP_DIR_64}\*.*"
      !endif
    !endif
  !else
    !ifdef APP_DIR_32
      File /r "${APP_DIR_32}\*.*"
    !else
      !insertmacro extractEmbeddedAppPackage
    !endif
  !endif

  FileOpen $0 "$INSTDIR\.bastion-portable-version" w
  FileWrite $0 "${VERSION}"
  FileClose $0

skip_extract:
  System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("PORTABLE_EXECUTABLE_DIR", "$EXEDIR").r0'
  System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("PORTABLE_EXECUTABLE_FILE", "$EXEPATH").r0'
  System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("PORTABLE_EXECUTABLE_APP_FILENAME", "${APP_FILENAME}").r0'
  ${StdUtils.GetAllParameters} $R0 0

  !ifdef SPLASH_IMAGE
    BgImage::Destroy
  !endif

  ExecWait "$INSTDIR\${APP_EXECUTABLE_FILENAME} $R0" $0
  SetErrorLevel $0

  SetOutPath $EXEDIR
  # Intentionally keep $INSTDIR so the next launch skips the multi‑hundred‑MB extract.
SectionEnd

Function TrimNewlines
  Exch $R9
  Push $R8
trim_loop:
  StrCpy $R8 $R9 1 -1
  StrCmp $R8 "$\r" trim_cut
  StrCmp $R8 "$\n" trim_cut
  Goto trim_done
trim_cut:
  StrCpy $R9 $R9 -1
  Goto trim_loop
trim_done:
  Pop $R8
  Exch $R9
FunctionEnd
