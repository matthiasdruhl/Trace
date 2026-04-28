param(
    [string]$StackName = "trace-eval",
    [string]$Region = "us-east-1",
    [string]$TraceDataBucketName = "trace-vault",
    [string]$TraceLancePrefix = "trace/eval/lance",
    [string]$OpenAiApiKeySecretRef = "trace/openai-api-key",
    [string]$OpenAiApiKeySecretJsonKey = "",
    [string]$TraceApiKeySecretRef = "",
    [string]$TraceApiKeySecretJsonKey = "",
    [string]$OpenAiEmbeddingModel = "text-embedding-3-small",
    [switch]$SkipFrontendPublish,
    [switch]$SkipSmokeTest
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

# SAM ignores omitted parameters on existing stacks, so we use an explicit
# sentinel for "clear this value" on secret-related parameters.
$emptyParameterSentinel = "__EMPTY__"

function Convert-TraceEmptyToSentinel {
    param(
        [AllowEmptyString()]
        [string]$Value
    )

    if ([string]::IsNullOrEmpty($Value)) {
        return $emptyParameterSentinel
    }

    return $Value
}

function Add-TraceParameterOverride {
    param(
        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [System.Collections.Generic.List[string]]$Overrides,
        [Parameter(Mandatory = $true)]
        [string]$Key,
        [string]$Value
    )

    if (-not [string]::IsNullOrEmpty($Value)) {
        $Overrides.Add("${Key}=${Value}")
    }
}

function Get-TraceSamParameterOverrides {
    param(
        [string]$TraceDataBucketName,
        [string]$TraceLancePrefix,
        [string]$TraceApiKeySecretRef,
        [string]$TraceApiKeySecretJsonKey,
        [string]$OpenAiApiKeySecretRef,
        [string]$OpenAiApiKeySecretJsonKey,
        [string]$OpenAiEmbeddingModel
    )

    $parameterOverrides = [System.Collections.Generic.List[string]]::new()

    Add-TraceParameterOverride -Overrides $parameterOverrides -Key "TraceDataBucketName" -Value $TraceDataBucketName
    Add-TraceParameterOverride -Overrides $parameterOverrides -Key "TraceLancePrefix" -Value $TraceLancePrefix
    Add-TraceParameterOverride -Overrides $parameterOverrides -Key "TraceApiKeySecretRef" -Value (Convert-TraceEmptyToSentinel -Value $TraceApiKeySecretRef)
    Add-TraceParameterOverride -Overrides $parameterOverrides -Key "TraceApiKeySecretJsonKey" -Value (Convert-TraceEmptyToSentinel -Value $TraceApiKeySecretJsonKey)
    Add-TraceParameterOverride -Overrides $parameterOverrides -Key "OpenAiApiKeySecretRef" -Value (Convert-TraceEmptyToSentinel -Value $OpenAiApiKeySecretRef)
    Add-TraceParameterOverride -Overrides $parameterOverrides -Key "OpenAiApiKeySecretJsonKey" -Value (Convert-TraceEmptyToSentinel -Value $OpenAiApiKeySecretJsonKey)
    Add-TraceParameterOverride -Overrides $parameterOverrides -Key "OpenAiEmbeddingModel" -Value $OpenAiEmbeddingModel

    return $parameterOverrides
}

function Invoke-NativeOrThrow {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,
        [string[]]$Arguments = @()
    )

    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$FilePath failed with exit code $LASTEXITCODE."
    }
}

function Invoke-TraceFullDeploy {
    $repoRoot = Split-Path -Parent $PSScriptRoot
    $builtTemplatePath = Join-Path $repoRoot ".aws-sam\build\template.yaml"

    Push-Location $repoRoot
    try {
        Invoke-NativeOrThrow -FilePath "sam" -Arguments @("build", "--beta-features")

        $parameterOverrides = Get-TraceSamParameterOverrides `
            -TraceDataBucketName $TraceDataBucketName `
            -TraceLancePrefix $TraceLancePrefix `
            -TraceApiKeySecretRef $TraceApiKeySecretRef `
            -TraceApiKeySecretJsonKey $TraceApiKeySecretJsonKey `
            -OpenAiApiKeySecretRef $OpenAiApiKeySecretRef `
            -OpenAiApiKeySecretJsonKey $OpenAiApiKeySecretJsonKey `
            -OpenAiEmbeddingModel $OpenAiEmbeddingModel

        $deployArgs = @(
            "deploy",
            "--template-file", $builtTemplatePath,
            "--stack-name", $StackName,
            "--region", $Region,
            "--capabilities", "CAPABILITY_IAM",
            "--resolve-s3",
            "--no-fail-on-empty-changeset"
        )

        if ($parameterOverrides.Count -gt 0) {
            $deployArgs += "--parameter-overrides"
            $deployArgs += $parameterOverrides
        }

        Invoke-NativeOrThrow `
            -FilePath "sam" `
            -Arguments $deployArgs

        if (-not $SkipFrontendPublish) {
            & (Join-Path $PSScriptRoot "deploy-frontend.ps1") `
                -StackName $StackName `
                -Region $Region `
                -SkipSmokeTest:$SkipSmokeTest
        }
    }
    finally {
        Pop-Location
    }
}

if ($MyInvocation.InvocationName -ne ".") {
    Invoke-TraceFullDeploy
}
