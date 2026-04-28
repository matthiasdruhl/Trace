from __future__ import annotations

import json
import shutil
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT_PATH = ROOT / "scripts" / "deploy-full.ps1"
POWERSHELL = shutil.which("pwsh") or shutil.which("powershell")


@unittest.skipIf(POWERSHELL is None, "PowerShell is required for deploy script tests")
class DeployFullScriptTests(unittest.TestCase):
    def _run_pwsh_json(self, command: str) -> list[str]:
        shell_name = Path(POWERSHELL).name.lower()
        args = [POWERSHELL, "-NoLogo", "-NoProfile"]
        if shell_name.startswith("powershell"):
            args += ["-ExecutionPolicy", "Bypass"]
        args += ["-Command", command]

        completed = subprocess.run(
            args,
            cwd=ROOT,
            check=True,
            capture_output=True,
            text=True,
        )
        return json.loads(completed.stdout)

    def test_secret_parameters_use_empty_sentinel(self) -> None:
        command = (
            f". '{SCRIPT_PATH.as_posix()}'; "
            "$overrides = Get-TraceSamParameterOverrides "
            "-TraceDataBucketName 'trace-vault' "
            "-TraceLancePrefix 'trace/eval/lance' "
            "-TraceApiKeySecretRef '' "
            "-TraceApiKeySecretJsonKey '' "
            "-OpenAiApiKeySecretRef 'trace/openai-api-key' "
            "-OpenAiApiKeySecretJsonKey '' "
            "-OpenAiEmbeddingModel 'text-embedding-3-small'; "
            "$overrides | ConvertTo-Json -Compress"
        )
        overrides = self._run_pwsh_json(command)
        self.assertIn("TraceApiKeySecretRef=__EMPTY__", overrides)
        self.assertIn("TraceApiKeySecretJsonKey=__EMPTY__", overrides)
        self.assertIn("OpenAiApiKeySecretJsonKey=__EMPTY__", overrides)
        self.assertIn("OpenAiApiKeySecretRef=trace/openai-api-key", overrides)

    def test_non_secret_empty_values_are_omitted(self) -> None:
        command = (
            f". '{SCRIPT_PATH.as_posix()}'; "
            "$overrides = Get-TraceSamParameterOverrides "
            "-TraceDataBucketName '' "
            "-TraceLancePrefix '' "
            "-TraceApiKeySecretRef '' "
            "-TraceApiKeySecretJsonKey '' "
            "-OpenAiApiKeySecretRef 'trace/openai-api-key' "
            "-OpenAiApiKeySecretJsonKey '' "
            "-OpenAiEmbeddingModel 'text-embedding-3-small'; "
            "$overrides | ConvertTo-Json -Compress"
        )
        overrides = self._run_pwsh_json(command)
        self.assertNotIn("TraceDataBucketName=", overrides)
        self.assertNotIn("TraceLancePrefix=", overrides)
        self.assertIn("TraceApiKeySecretRef=__EMPTY__", overrides)
        self.assertIn("OpenAiEmbeddingModel=text-embedding-3-small", overrides)
