; Entrées « Ouvrir avec viviMemories » dans le clic droit de l'Explorateur
; (sous Windows 11 : « Afficher d'autres options »).
!macro customInstall
  WriteRegStr HKCU "Software\Classes\Directory\shell\viviMemories" "" "Ouvrir avec viviMemories"
  WriteRegStr HKCU "Software\Classes\Directory\shell\viviMemories" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  WriteRegStr HKCU "Software\Classes\Directory\shell\viviMemories\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\viviMemories" "" "Diaporama de ce dossier avec viviMemories"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\viviMemories" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\viviMemories\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%V"'
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\Directory\shell\viviMemories"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\viviMemories"
!macroend
