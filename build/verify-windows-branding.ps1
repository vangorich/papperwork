# Read-only Windows shell name verification. Does not change file associations.
param([string] $Extension = '.pdf', [string] $Application = 'Paperwork PDF Studio.exe')
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class PaperworkAssociationQuery {
  [DllImport("shlwapi.dll", CharSet=CharSet.Unicode, EntryPoint="AssocQueryStringW")]
  static extern int Query(uint flags, uint kind, string association, string extra, StringBuilder output, ref uint length);
  public static string Get(uint flags, uint kind, string association) {
    uint length=32768;
    var output=new StringBuilder((int)length);
    int result=Query(flags,kind,association,null,output,ref length);
    if(result!=0) Marshal.ThrowExceptionForHR(result);
    return output.ToString();
  }
}
'@
[pscustomobject]@{
    Extension = $Extension
    DefaultExecutable = [PaperworkAssociationQuery]::Get(0, 2, $Extension)
    DefaultFriendlyName = [PaperworkAssociationQuery]::Get(0, 4, $Extension)
    ApplicationFriendlyName = [PaperworkAssociationQuery]::Get(2, 4, $Application)
    RegisteredCommand = (Get-Item -LiteralPath "Registry::HKEY_CURRENT_USER\Software\Classes\Applications\$Application\shell\open\command").GetValue('')
} | ConvertTo-Json
