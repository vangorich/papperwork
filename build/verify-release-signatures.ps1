param(
  [Parameter(Mandatory = $false)]
  [string]$Directory = "signed-release",

  [Parameter(Mandatory = $false)]
  [string]$CertificateIdentity,

  [Parameter(Mandatory = $false)]
  [string]$CertificateOidcIssuer = "https://token.actions.githubusercontent.com"
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command cosign -ErrorAction SilentlyContinue)) {
  throw "cosign is required. Install it from https://github.com/sigstore/cosign/releases"
}

$files = Get-ChildItem $Directory -File -Filter "*.exe"
if (-not $files) {
  throw "No .exe release artifacts found in $Directory"
}

$expectedHashes = @{}
$checksumFile = Join-Path $Directory "SHA256SUMS.txt"
if (Test-Path $checksumFile) {
  foreach ($line in Get-Content $checksumFile) {
    if ($line -match '^([0-9a-fA-F]{64})\s{2}(.+)$') {
      $expectedHashes[$Matches[2]] = $Matches[1].ToLowerInvariant()
    }
  }
}

$failed = $false
foreach ($file in $files) {
  $hash = (Get-FileHash $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  $hashMatches = -not $expectedHashes.ContainsKey($file.Name) -or $expectedHashes[$file.Name] -eq $hash
  $bundle = "$($file.FullName).sigstore.json"
  $authenticode = Get-AuthenticodeSignature $file.FullName

  $arguments = @('verify-blob', '--bundle', $bundle)
  if ($CertificateIdentity) {
    $arguments += @(
      '--certificate-identity', $CertificateIdentity,
      '--certificate-oidc-issuer', $CertificateOidcIssuer
    )
  } else {
    $arguments += @(
      '--certificate-identity-regexp', '^https://github.com/.+/.github/workflows/release-sigstore\.yml@refs/(heads|tags)/.+$',
      '--certificate-oidc-issuer', $CertificateOidcIssuer
    )
  }
  $arguments += $file.FullName

  & cosign @arguments
  $sigstoreValid = $LASTEXITCODE -eq 0
  if (-not $hashMatches -or -not $sigstoreValid) { $failed = $true }

  [pscustomobject]@{
    File = $file.Name
    SHA256 = $hash
    Checksum = if ($hashMatches) { 'Valid' } else { 'Mismatch' }
    Sigstore = if ($sigstoreValid) { 'Valid' } else { 'Invalid' }
    Authenticode = [string]$authenticode.Status
    Publisher = if ($authenticode.SignerCertificate) { $authenticode.SignerCertificate.Subject } else { '' }
  } | Format-List
}

if ($failed) {
  throw "One or more release signatures or checksums failed verification."
}
