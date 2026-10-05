from backend.observer.session import ProjectSession


def test_step_files_and_reporting_paths_survive_scan_noise_and_reconnect_snapshot(tmp_path):
    session = ProjectSession(tmp_path, "Test agent", lambda frame: None)
    working = session.emit(
        "graph_edge_added", event_source="agent", id="working:file:main.py",
        source="agent", target="file:main.py", label="working on", evidence="reported",
        message="Editing main.py",
    )
    report = session.emit(
        "agent_stage", "running", event_source="agent", stage="IMPLEMENTING", message="Add a handler"
    )
    saved = session.emit("file_modified", path="main.py", nodeId="file:main.py", message="Saved handler")
    for index in range(650):
        session.emit("graph_node_updated", nodeId="file:main.py", state="completed", message=f"Indexed {index}")

    snapshot = session.snapshot()
    assert len(snapshot["events"]) == 500
    assert report not in snapshot["events"]
    assert snapshot["activityEvents"] == [working, report, saved]
    assert snapshot["graph"]["edges"][0]["target"] == "file:main.py"


def test_activity_history_is_bounded_and_cannot_leak_another_project(tmp_path):
    session = ProjectSession(tmp_path, "Test agent", lambda frame: None)
    for index in range(2050):
        session.emit("agent_message", event_source="agent", message=f"Action {index}")
    assert len(session.snapshot()["activityEvents"]) == 2000
    assert session.snapshot()["activityEvents"][0]["data"]["message"] == "Action 50"
    another = ProjectSession(tmp_path / "another", "Test agent", lambda frame: None)
    assert another.snapshot()["activityEvents"] == []


def test_latest_agent_report_and_failed_stage_survive_substantive_history_rollover(tmp_path):
    session = ProjectSession(tmp_path, "Test agent", lambda frame: None)
    failed = session.emit(
        "agent_stage", "failed", event_source="agent", agent_name="First assistant",
        stage="DEBUGGING", message="Could not connect the API",
    )
    report = session.emit(
        "agent_message", "running", event_source="agent", agent_name="Second assistant",
        message="Connecting the login form",
    )
    for index in range(2005):
        saved = session.emit(
            "file_modified", path="main.py", nodeId="file:main.py", message=f"Save {index}"
        )
    session.emit("agent_message", event_source="system", message="Watcher stopped")

    snapshot = session.snapshot()
    assert len(snapshot["activityEvents"]) == 2000
    assert report not in snapshot["activityEvents"]
    assert report not in snapshot["events"]
    assert report in snapshot["retainedEvents"]
    assert saved in snapshot["activityEvents"]
    retained_stage = next(event for event in snapshot["retainedEvents"] if event["eventId"] == failed["eventId"])
    assert retained_stage["status"] == "failed"
    assert retained_stage["agentName"] == "First assistant"
    assert session.retained["agent_report"] == report
    assert session.retained["current"]["source"] == "system"
    assert ProjectSession(tmp_path / "another", "Test agent", lambda frame: None).snapshot()["retainedEvents"] == []
