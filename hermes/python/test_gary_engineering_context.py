"""Pure adapter tests. Never import or launch the native runtime."""
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import time
import types
import unittest
from unittest.mock import patch

from gary_engineering_runtime import EngineeringFault, EngineeringSession, ScopedNativeContext, native_context_from_start


def session(rpc):
    return EngineeringSession(dict(taskId="task", sessionId="session", ownerEpoch="owner", deadlineMs=int(time.time()*1000)+60000), rpc)


class ContextTests(unittest.TestCase):
    def test_task_rpc_requires_active_matching_observed_native_call(self):
        frames = []
        def rpc(frame):
            frames.append(frame)
            out = dict(ok=True, receiptId="receipt-"+str(len(frames)))
            if frame["kind"] == "tool.begin":
                out["admissionId"] = "admission"
            elif frame["kind"] == "task.operation":
                out["result"] = {"status": "completed"}
            return out
        s = session(rpc)
        s.begin_turn("turn")
        with self.assertRaisesRegex(EngineeringFault, "unbound"):
            s.task_rpc("code.run", {"code": "pass"})
        entry = types.SimpleNamespace(handler=lambda: None)
        s.native_entries = {"execute_code": entry}
        s._handlers = {"execute_code": entry.handler}
        s.registry = types.SimpleNamespace(get_entry=lambda name: entry)
        result = s.middleware(tool_name="execute_code", args={"code": "pass"}, original_args={"code": "pass"},
            task_id="task", session_id="session", tool_call_id="call",
            next_call=lambda args: s.task_rpc("code.run", args))
        self.assertEqual(result, {"status": "completed"})
        self.assertEqual([f["kind"] for f in frames], ["tool.begin", "task.operation", "tool.end"])
        self.assertEqual(frames[1]["payload"]["admissionId"], "admission")
        self.assertEqual(frames[2]["payload"]["operationReceipts"], ["receipt-2"])
        with self.assertRaisesRegex(EngineeringFault, "unbound"):
            s.task_rpc("code.run", {"code": "pass"})

    def test_mismatched_task_operation_never_reaches_host(self):
        frames = []
        def rpc(frame):
            frames.append(frame)
            return dict(ok=True, receiptId="receipt", admissionId="admit")
        s = session(rpc); s.begin_turn("turn")
        entry = types.SimpleNamespace(handler=lambda: None)
        s.native_entries = {"execute_code": entry}; s._handlers = {"execute_code": entry.handler}
        s.registry = types.SimpleNamespace(get_entry=lambda name: entry)
        result = s.middleware(tool_name="execute_code", args={"code":"pass"}, original_args={"code":"pass"},
            task_id="task", session_id="session", tool_call_id="call",
            next_call=lambda args: s.task_rpc("delegate.run", {"goal":"not observed"}))
        self.assertEqual(json.loads(result)["error"], "native_tool_failed")
        self.assertEqual([f["kind"] for f in frames], ["tool.begin", "tool.end"])

    def test_context_selects_only_derived_materialized_native_state_and_closes_wal(self):
        class DB:
            def __init__(self, db_path):
                self.db_path = db_path; self.closed = 0
                self.connection = sqlite3.connect(db_path)
                self.connection.execute("PRAGMA journal_mode=WAL")
                self.connection.execute("CREATE TABLE history(content TEXT)")
                self.connection.commit()
            def close(self):
                self.closed += 1; self.connection.close()
        with tempfile.TemporaryDirectory() as directory:
            home=Path(directory).resolve(); memory=home/"hermes"/"memory";memory.mkdir(parents=True)
            (memory/"MEMORY.md").write_text("scoped memory")
            value=dict(version=1,scopeKey="scope",tools=["memory","todo","session_search"],delegationDepth=0,confinedCode=False)
            with patch.dict("sys.modules", {"hermes_state":types.SimpleNamespace(SessionDB=DB)}):
                context=native_context_from_start(value,home)
            self.assertEqual(context.memory_dir,memory)
            self.assertEqual(context.session_db.db_path,home/"hermes"/"session.sqlite")
            self.assertEqual(context.approved_skills,"/task/skills-approved")
            self.assertEqual(context.draft_skills,"/task/skill-drafts")
            agent=types.SimpleNamespace();context.configure_agent(agent)
            self.assertIs(agent._session_db,context.session_db);self.assertFalse(agent._persist_disabled)
            context.close();context.close();self.assertEqual(context.session_db.closed,1)
            self.assertFalse(Path(str(context.session_db.db_path)+"-wal").exists())
            self.assertEqual(os.stat(context.session_db.db_path).st_mode & 0o777,0o600)
            self.assertEqual(os.stat(memory/"MEMORY.md").st_mode & 0o777,0o600)

    def test_wire_cannot_select_restore_path_or_recursion(self):
        base=dict(version=1,scopeKey="scope",tools=["todo"],delegationDepth=0,confinedCode=False)
        for delta in ({"home":"/other"},{"tools":["host_shell"]},{"tools":["todo","todo"]},{"tools":["delegate_task"],"delegationDepth":1}):
            with self.assertRaises(EngineeringFault):
                native_context_from_start(dict(base,**delta),"/not-opened")

    def test_confined_native_sdk_inherits_exact_one_use_nested_admissions_and_receipt_order(self):
        frames=[]
        s=None
        def rpc(frame):
            frames.append(frame);p=frame["payload"]
            r=dict(ok=True,receiptId="r"+str(len(frames)))
            if frame["kind"]=="tool.begin":r["admissionId"]="a"+str(len(frames))
            if frame["kind"]=="code.authorize":r.update(codeCapability="cap",allowedTools=["terminal"],deadlineMs=s.deadline_ms)
            if frame["kind"]=="code.start":r["codeInvocationId"]="code-invocation"
            if frame["kind"]=="environment.operation":r.update(processId="process",status="running")
            return r
        s=session(rpc);s.begin_turn("turn")
        entries={name:types.SimpleNamespace(handler=lambda:None) for name in ("execute_code","terminal")}
        s.native_entries=entries;s._handlers={k:e.handler for k,e in entries.items()}
        s.registry=types.SimpleNamespace(get_entry=lambda name:entries[name])
        def code_handler(args):
            def closing():
                self.assertTrue(s._code_tool_lock.locked())
                late=s.middleware(tool_name="terminal",args={"command":"late"},original_args={"command":"late"},
                    task_id="task",next_call=lambda args:self.fail("late SDK call ran"))
                self.assertEqual(json.loads(late)["status"],"blocked")
            s.begin_code(args["code"],cleanup_guard=closing)
            result=s.middleware(tool_name="terminal",args={"command":"echo hi"},original_args={"command":"echo hi"},task_id="task",
                next_call=lambda args:json.dumps(s.environment_rpc("execute",dict(operationId="op",command=args["command"]))))
            self.assertIn('process',result)
            return json.dumps({"status":"success","output":"hi"})
        result=s.middleware(tool_name="execute_code",args={"code":"terminal(command='echo hi')"},original_args={"code":"terminal(command='echo hi')"},
            task_id="task",session_id="session",tool_call_id="outer",next_call=code_handler)
        self.assertEqual(json.loads(result)["status"],"success")
        self.assertEqual([f["kind"] for f in frames],["tool.begin","code.authorize","code.start","tool.begin","environment.operation","tool.end","code.end","tool.end"])
        self.assertEqual(frames[6]["payload"]["operationReceipts"],["r4","r5","r6"])
        self.assertEqual(frames[7]["payload"]["operationReceipts"],["r2","r3","r7"])
        self.assertEqual(frames[5]["payload"]["operationReceipts"],["r5"])
        self.assertEqual(frames[3]["payload"]["parentToolCallId"],"outer")
        self.assertIsNone(s._code_invocation)
        self.assertEqual(s._calls,{"outer"})


    def test_leftover_native_script_process_fences_without_completion_receipts(self):
        frames=[]
        s=None
        def rpc(frame):
            frames.append(frame)
            r=dict(ok=True,receiptId="r"+str(len(frames)))
            if frame["kind"]=="tool.begin":r["admissionId"]="admit"
            if frame["kind"]=="code.authorize":r.update(codeCapability="cap",allowedTools=[],deadlineMs=s.deadline_ms)
            if frame["kind"]=="code.start":r["codeInvocationId"]="code-invocation"
            return r
        s=session(rpc);s.begin_turn("turn")
        entry=types.SimpleNamespace(handler=lambda:None)
        s.native_entries={"execute_code":entry};s._handlers={"execute_code":entry.handler}
        s.registry=types.SimpleNamespace(get_entry=lambda name:entry)
        def uncertain():raise EngineeringFault("leftover descendant")
        def handler(args):
            s.begin_code(args["code"],cleanup_guard=uncertain)
            return json.dumps({"status":"success"})
        result=s.middleware(tool_name="execute_code",args={"code":"pass"},original_args={"code":"pass"},
            task_id="task",session_id="session",tool_call_id="outer",next_call=handler)
        self.assertEqual(json.loads(result)["status"],"blocked")
        self.assertTrue(s._fenced)
        self.assertEqual([f["kind"] for f in frames],["tool.begin","code.authorize","code.start"])


if __name__ == "__main__":
    unittest.main()
