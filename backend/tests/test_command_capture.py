from pathlib import Path
import sys

import pytest

from backend.command_capture import read_junit, run_command


class Client:
    def __init__(self, root):
        self.root = root
        self.events = []

    def request(self, method, path, payload=None):
        if method == "GET":
            return {"session": {"runId": "watched-run", "projectPath": str(self.root), "watching": True}}
        self.events.append((path, payload))
        return {"accepted": True}


def test_real_command_captures_output_exit_and_project_directory(tmp_path, capsys):
    client = Client(tmp_path)
    code = "import pathlib; print(pathlib.Path.cwd().name); print('actual output'); raise SystemExit(4)"
    result = run_command(client, [sys.executable, "-c", code])
    assert result == 4
    assert tmp_path.name in capsys.readouterr().out
    started, finished = [event for _, event in client.events]
    assert started["status"] == "running"
    assert finished["status"] == "failed" and finished["exitCode"] == 4
    assert finished["capture"] == "wrapper"
    assert started["commandId"] == finished["commandId"]
    assert "actual output" in finished["output"]


def test_real_command_reads_only_fresh_junit_results(tmp_path):
    client = Client(tmp_path)
    xml = '<testsuite><testcase name="created" classname="todos"/><testcase name="broken"><failure message="missing id">Expected 1</failure></testcase><testcase name="later"><skipped/></testcase></testsuite>'
    code = f"from pathlib import Path; Path('results.xml').write_text({xml!r})"
    assert run_command(client, [sys.executable, "-c", code], junit="results.xml", attempt=2) == 0
    results = [event for path, event in client.events if path == "/api/agent/test"]
    assert [result["status"] for result in results] == ["passed", "failed"]
    assert results[0]["name"] == "todos::created" and results[0]["attempt"] == 2
    assert "missing id" in results[1]["details"]
    client.events.clear()
    assert run_command(client, [sys.executable, "-c", "pass"], junit="results.xml") == 0
    assert not any(path == "/api/agent/test" for path, _ in client.events)


def test_command_output_retention_is_bounded(tmp_path, capsys):
    client = Client(tmp_path)
    run_command(client, [sys.executable, "-c", "print('x' * 25000)"])
    assert len(client.events[-1][1]["output"]) == 16000
    capsys.readouterr()


def test_capture_rejects_report_outside_project_before_execution(tmp_path):
    client = Client(tmp_path)
    with pytest.raises(ValueError, match="inside"):
        run_command(client, [sys.executable, "-c", "raise SystemExit(0)"], junit="../outside.xml")
    assert client.events == []


def test_junit_rejects_entity_declarations(tmp_path):
    report = Path(tmp_path) / "results.xml"
    report.write_text('<!DOCTYPE testsuite [<!ENTITY x "secret">]><testsuite/>')
    with pytest.raises(ValueError, match="declarations"):
        read_junit(report)


def test_missing_command_is_reported_as_failure(tmp_path):
    client = Client(tmp_path)
    assert run_command(client, [str(tmp_path / "not-a-real-command")]) == 1
    assert client.events[-1][1]["status"] == "failed"
