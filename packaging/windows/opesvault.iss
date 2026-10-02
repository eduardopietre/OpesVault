; OPTIONAL installer (Inno Setup 6). The app also runs from the Nuitka standalone folder
; or directly with `uv run python -m opesvault`; nothing here is required.
;
; Build: uv run --group build python scripts/build.py --installer
; Needs ISCC.exe (Inno Setup) on PATH or in its default folder.
; No downloads at install time and no network use at first run (docs/02 §7).

#define AppName "OpesVault"
#ifndef AppVersion
  #define AppVersion "0.1.0"
#endif
#ifndef SourceDir
  #define SourceDir "..\..\build\nuitka\opesvault_entry.dist"
#endif

[Setup]
AppId={{6F1C3D2A-1B7E-4B8E-9F00-0C0FFEE0A001}
AppName={#AppName}
AppVersion={#AppVersion}
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
OutputDir=..\..\build\installer
OutputBaseFilename=OpesVault-{#AppVersion}-setup
Compression=lzma2
SolidCompression=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequiredOverridesAllowed=dialog
DisableProgramGroupPage=yes
; Vault files stay wherever the user saves them; uninstalling never touches them.
UninstallDisplayName={#AppName}

[Languages]
Name: "brazilianportuguese"; MessagesFile: "compiler:Languages\BrazilianPortuguese.isl"

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: recursesubdirs ignoreversion

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\OpesVault.exe"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\OpesVault.exe"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Criar atalho na área de trabalho"; Flags: unchecked
Name: "associate"; Description: "Abrir arquivos .opesvault com o OpesVault"; Flags: unchecked

[Registry]
; File association is optional and only for the current user.
Root: HKCU; Subkey: "Software\Classes\.opesvault"; ValueType: string; ValueData: "OpesVault.Cofre"; Flags: uninsdeletevalue; Tasks: associate
Root: HKCU; Subkey: "Software\Classes\OpesVault.Cofre"; ValueType: string; ValueData: "Cofre OpesVault"; Flags: uninsdeletekey; Tasks: associate
Root: HKCU; Subkey: "Software\Classes\OpesVault.Cofre\shell\open\command"; ValueType: string; ValueData: """{app}\OpesVault.exe"" ""%1"""; Tasks: associate
