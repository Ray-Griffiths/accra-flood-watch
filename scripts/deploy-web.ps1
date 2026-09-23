<#
.SYNOPSIS
    Builds the PWA and publishes it to S3 behind CloudFront.

.DESCRIPTION
    Cache headers are set at upload time, which is the whole point of doing this
    in two passes: hashed asset filenames are immutable and cached for a year,
    while index.html and the service worker are no-cache so that users receive
    updates promptly rather than being stuck on an old build.
#>
[CmdletBinding()]
param(
    [string]$StackName = "accra-flood-watch",
    [string]$Region = "eu-west-1",
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot

Write-Host "Reading stack outputs from $StackName ($Region)..." -ForegroundColor Cyan
$outputsJson = aws cloudformation describe-stacks `
    --stack-name $StackName `
    --region $Region `
    --query "Stacks[0].Outputs" `
    --output json
if ($LASTEXITCODE -ne 0) { throw "Could not read stack outputs. Has 'sam deploy' run?" }

$outputs = $outputsJson | ConvertFrom-Json
function Get-Output([string]$key) {
    $match = $outputs | Where-Object { $_.OutputKey -eq $key }
    if (-not $match) { throw "Stack output '$key' not found." }
    return $match.OutputValue
}

$bucket = Get-Output "WebBucketName"
$distributionId = Get-Output "DistributionId"
$siteUrl = Get-Output "SiteUrl"

if (-not $SkipBuild) {
    Write-Host "Building the PWA..." -ForegroundColor Cyan
    Push-Location (Join-Path $repoRoot "web")
    try {
        npm run build
        if ($LASTEXITCODE -ne 0) { throw "Vite build failed." }
    }
    finally { Pop-Location }
}

$dist = Join-Path $repoRoot "web\dist"
if (-not (Test-Path $dist)) { throw "Build output not found at $dist" }

# Pass 1: everything immutable. Hashed filenames mean a year is safe.
Write-Host "Uploading immutable assets..." -ForegroundColor Cyan
aws s3 sync $dist "s3://$bucket" `
    --region $Region `
    --delete `
    --cache-control "public, max-age=31536000, immutable" `
    --exclude "index.html" `
    --exclude "service-worker.js" `
    --exclude "manifest.webmanifest" `
    --exclude "open-data/*"
if ($LASTEXITCODE -ne 0) { throw "Asset upload failed." }

# Pass 2: the entry point and service worker must never be cached, or users
# stay pinned to an old build after a deploy.
Write-Host "Uploading entry point and service worker..." -ForegroundColor Cyan
aws s3 cp (Join-Path $dist "index.html") "s3://$bucket/index.html" `
    --region $Region `
    --cache-control "no-cache, must-revalidate" `
    --content-type "text/html; charset=utf-8"
if ($LASTEXITCODE -ne 0) { throw "index.html upload failed." }

aws s3 cp (Join-Path $dist "service-worker.js") "s3://$bucket/service-worker.js" `
    --region $Region `
    --cache-control "no-cache, must-revalidate" `
    --content-type "text/javascript; charset=utf-8"
if ($LASTEXITCODE -ne 0) { throw "service-worker.js upload failed." }

aws s3 cp (Join-Path $dist "manifest.webmanifest") "s3://$bucket/manifest.webmanifest" `
    --region $Region `
    --cache-control "no-cache, must-revalidate" `
    --content-type "application/manifest+json"
if ($LASTEXITCODE -ne 0) { throw "manifest upload failed." }

# Open data is published under a stable, unhashed path so it can be cited and
# linked. That means it must NOT get the year-long immutable caching the
# hashed assets get, or a regenerated grid would be invisible for a year. A
# day is long enough to keep it cheap and short enough to stay honest.
Write-Host "Uploading open data..." -ForegroundColor Cyan
$openData = Join-Path $dist "open-data"
if (Test-Path $openData) {
    aws s3 sync $openData "s3://$bucket/open-data" `
        --region $Region `
        --delete `
        --cache-control "public, max-age=86400"
    if ($LASTEXITCODE -ne 0) { throw "Open data upload failed." }
}

Write-Host "Invalidating CloudFront cache..." -ForegroundColor Cyan
aws cloudfront create-invalidation `
    --distribution-id $distributionId `
    --paths "/index.html" "/service-worker.js" "/manifest.webmanifest" "/open-data/*" `
    --query "Invalidation.Id" `
    --output text
if ($LASTEXITCODE -ne 0) { throw "Invalidation failed." }

Write-Host ""
Write-Host "Deployed: $siteUrl" -ForegroundColor Green
Write-Host "Health:   $siteUrl/api/health" -ForegroundColor Green
