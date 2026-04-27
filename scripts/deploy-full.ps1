param(
    [string]$StackName = "trace-eval",
    [string]$Region = "us-east-1",
    [string]$TraceDataBucketName = "trace-vault",
    [string]$TraceLancePrefix = "trace/eval/lance",
    [string]$OpenAiApiKeySecretRef = "trace/openai-api-key",
    [string]$OpenAiApiKeySecretJsonKey = "openaiApiKey",
    [switch]$SkipFrontendPublish
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $PSScriptRoot

Push-Location $repoRoot
try {
    sam build --beta-features

    $deployArgs = @(
        "deploy",
        "--stack-name", $StackName,
        "--region", $Region,
        "--capabilities", "CAPABILITY_IAM",
        "--resolve-s3",
        "--parameter-overrides",
        "TraceDataBucketName=$TraceDataBucketName",
        "TraceLancePrefix=$TraceLancePrefix",
        "OpenAiApiKeySecretRef=$OpenAiApiKeySecretRef"
    )

    if ($OpenAiApiKeySecretJsonKey) {
        $deployArgs += "OpenAiApiKeySecretJsonKey=$OpenAiApiKeySecretJsonKey"
    }

    & sam @deployArgs

    if (-not $SkipFrontendPublish) {
        & (Join-Path $PSScriptRoot "deploy-frontend.ps1") `
            -StackName $StackName `
            -Region $Region
    }
}
finally {
    Pop-Location
}
