# Kingu's Jupyter kernel bridge (notebook/kernel.rs runs it with the Python that has jupyter_client).
#
#   python -c <this file> list        prints the kernelspecs as one JSON line
#   python -c <this file> run <name>  starts kernel <name> in the current directory
#
# While running, requests come in on stdin and events go out on stdout, one JSON object per line:
#   in:  {"op": "execute", "run": "<id>", "code": "..."} | {"op": "interrupt"} | {"op": "restart"} | {"op": "shutdown"}
#   out: {"ev": "ready", "info": {...}}                kernel_info's language_info and banner
#        {"ev": "status", "state": "busy" | "idle" | "restarting"}
#        {"ev": "input", "run": id, "count": n}        the execution count, as soon as the kernel assigns it
#        {"ev": "output", "run": id, "output": {...}}  an nbformat 4 output (stream, display_data, execute_result, error)
#        {"ev": "clear", "run": id, "wait": bool}      clear_output
#        {"ev": "done", "run": id, "count": n | null, "status": "ok" | "error" | "aborted"}
#        {"ev": "fatal", "message": "..."}             the kernel could not start or died
# jupyter_client does the ZeroMQ, message signing, interrupts and restarts. Cells run one at a time
# in request order; an interrupt or a restart drops the ones still waiting (they end "aborted").
# KINGU_KERNEL_FAKE=1 swaps in a tiny in-process kernel so the bridge can be tested without Jupyter.

import json
import os
import queue
import sys
import threading
import time

_out = threading.Lock()


def emit(obj):
	with _out:
		sys.stdout.write(json.dumps(obj) + '\n')
		sys.stdout.flush()


# ------------------------------------------------------------------------------------------------
# The fake kernel (tests only): prints the code back, `raise` errors, `sleep N` waits (interruptible).


class _FakeClient:
	def __init__(self, km):
		self.km = km
		self.iopub = queue.Queue()
		self.shell = queue.Queue()
		self.count = 0
		self.n = 0

	def start_channels(self):
		pass

	def stop_channels(self):
		pass

	def wait_for_ready(self, timeout=None):
		pass

	def kernel_info(self, reply=False):
		return {'content': {'language_info': {'name': 'python', 'version': '3', 'file_extension': '.py'}, 'banner': 'fake kernel'}}

	def _msg(self, parent, msg_type, content):
		return {'parent_header': {'msg_id': parent}, 'msg_type': msg_type, 'header': {'msg_type': msg_type}, 'content': content}

	def execute(self, code, **_):
		self.n += 1
		mid = 'fake-%d' % self.n
		threading.Thread(target=self._run, args=(mid, code), daemon=True).start()
		return mid

	def _run(self, mid, code):
		self.count += 1
		n = self.count
		put = lambda t, c: self.iopub.put(self._msg(mid, t, c))
		put('status', {'execution_state': 'busy'})
		put('execute_input', {'code': code, 'execution_count': n})
		status = 'ok'
		if code.startswith('sleep'):
			end = time.time() + float(code.split()[1])
			while time.time() < end and not self.km.interrupted:
				time.sleep(0.01)
			if self.km.interrupted:
				self.km.interrupted = False
				put('error', {'ename': 'KeyboardInterrupt', 'evalue': '', 'traceback': ['KeyboardInterrupt']})
				status = 'error'
		elif code.startswith('raise'):
			put('error', {'ename': 'ValueError', 'evalue': 'boom', 'traceback': ['\x1b[0;31mValueError\x1b[0m: boom']})
			status = 'error'
		else:
			put('stream', {'name': 'stdout', 'text': code + '\n'})
			put('execute_result', {'execution_count': n, 'data': {'text/plain': str(len(code))}, 'metadata': {}})
		put('status', {'execution_state': 'idle'})
		self.shell.put(self._msg(mid, 'execute_reply', {'status': status, 'execution_count': n}))

	def get_iopub_msg(self, timeout=None):
		return self.iopub.get(timeout=timeout)

	def get_shell_msg(self, timeout=None):
		return self.shell.get(timeout=timeout)


class _FakeManager:
	def __init__(self, kernel_name):
		self.interrupted = False
		self._client = _FakeClient(self)

	def start_kernel(self, **_):
		pass

	def client(self):
		return self._client

	def is_alive(self):
		return True

	def interrupt_kernel(self):
		self.interrupted = True

	def restart_kernel(self, now=False):
		self._client.count = 0

	def shutdown_kernel(self, now=False):
		pass


# ------------------------------------------------------------------------------------------------


def list_specs():
	from jupyter_client.kernelspec import KernelSpecManager

	specs = []
	for name, entry in sorted(KernelSpecManager().get_all_specs().items()):
		spec = entry.get('spec', {})
		specs.append({'name': name, 'display_name': spec.get('display_name') or name, 'language': spec.get('language') or ''})
	emit({'ev': 'specs', 'specs': specs, 'python': sys.executable})


OUTPUT_TYPES = ('stream', 'display_data', 'execute_result', 'error', 'update_display_data')


def to_output(msg_type, content):
	"""An iopub message as an nbformat 4 output."""
	if msg_type == 'stream':
		return {'output_type': 'stream', 'name': content.get('name', 'stdout'), 'text': content.get('text', '')}
	if msg_type == 'error':
		return {'output_type': 'error', 'ename': content.get('ename', ''), 'evalue': content.get('evalue', ''), 'traceback': content.get('traceback', [])}
	out = {'output_type': 'display_data' if msg_type == 'update_display_data' else msg_type, 'data': content.get('data', {}), 'metadata': content.get('metadata', {})}
	if msg_type == 'execute_result':
		out['execution_count'] = content.get('execution_count')
	return out


class Bridge:
	def __init__(self, kernel_name):
		if os.environ.get('KINGU_KERNEL_FAKE') == '1':
			self.km = _FakeManager(kernel_name)
		else:
			from jupyter_client.manager import KernelManager

			self.km = KernelManager(kernel_name=kernel_name)
		self.jobs = queue.Queue()
		self.generation = 0
		self.lock = threading.Lock()

	def start(self):
		self.km.start_kernel(cwd=os.getcwd())
		self.kc = self.km.client()
		self.kc.start_channels()
		self._ready()
		threading.Thread(target=self._worker, daemon=True).start()

	def _ready(self):
		self.kc.wait_for_ready(timeout=60)
		info = {}
		try:
			reply = self.kc.kernel_info(reply=True)
			content = reply.get('content', {}) if isinstance(reply, dict) else {}
			info = {'language_info': content.get('language_info', {}), 'banner': content.get('banner', '')}
		except Exception:
			pass
		emit({'ev': 'ready', 'info': info})
		emit({'ev': 'status', 'state': 'idle'})

	def _drop_waiting(self):
		while True:
			try:
				job = self.jobs.get_nowait()
			except queue.Empty:
				return
			if job.get('op') == 'execute':
				emit({'ev': 'done', 'run': job['run'], 'count': None, 'status': 'aborted'})

	def _worker(self):
		while True:
			job = self.jobs.get()
			try:
				if job.get('op') == 'ready':
					self._ready()
				elif job.get('op') == 'execute':
					self._execute(job['run'], job.get('code', ''))
			except Exception as e:
				emit({'ev': 'fatal', 'message': str(e)})

	def _execute(self, run, code):
		generation = self.generation
		emit({'ev': 'status', 'state': 'busy'})
		mid = self.kc.execute(code, store_history=True, allow_stdin=False, stop_on_error=True)
		count = None
		while True:
			if generation != self.generation:
				emit({'ev': 'done', 'run': run, 'count': count, 'status': 'aborted'})
				return
			try:
				msg = self.kc.get_iopub_msg(timeout=0.2)
			except queue.Empty:
				if not self.km.is_alive():
					emit({'ev': 'done', 'run': run, 'count': count, 'status': 'aborted'})
					emit({'ev': 'fatal', 'message': 'The kernel died.'})
					return
				continue
			if msg.get('parent_header', {}).get('msg_id') != mid:
				continue
			kind = msg.get('msg_type') or msg.get('header', {}).get('msg_type')
			content = msg.get('content', {})
			if kind == 'execute_input':
				count = content.get('execution_count')
				emit({'ev': 'input', 'run': run, 'count': count})
			elif kind in OUTPUT_TYPES:
				emit({'ev': 'output', 'run': run, 'output': to_output(kind, content)})
			elif kind == 'clear_output':
				emit({'ev': 'clear', 'run': run, 'wait': bool(content.get('wait'))})
			elif kind == 'status' and content.get('execution_state') == 'idle':
				break
		status = 'ok'
		deadline = time.time() + 5
		while time.time() < deadline:
			try:
				reply = self.kc.get_shell_msg(timeout=0.5)
			except queue.Empty:
				continue
			if reply.get('parent_header', {}).get('msg_id') == mid:
				status = reply.get('content', {}).get('status', 'ok')
				count = reply.get('content', {}).get('execution_count', count)
				break
		emit({'ev': 'done', 'run': run, 'count': count, 'status': status})
		emit({'ev': 'status', 'state': 'idle'})

	def handle(self, req):
		op = req.get('op')
		if op == 'execute':
			self.jobs.put(req)
		elif op == 'interrupt':
			self._drop_waiting()
			self.km.interrupt_kernel()
		elif op == 'restart':
			self._drop_waiting()
			self.generation += 1
			emit({'ev': 'status', 'state': 'restarting'})
			self.km.restart_kernel(now=False)
			self.jobs.put({'op': 'ready'})
		elif op == 'shutdown':
			return False
		return True

	def stop(self):
		try:
			self.kc.stop_channels()
		finally:
			self.km.shutdown_kernel(now=False)


def run(kernel_name):
	bridge = Bridge(kernel_name)
	try:
		bridge.start()
	except Exception as e:
		emit({'ev': 'fatal', 'message': str(e)})
		return 1
	# stdin closing (the app quit) shuts the kernel down too.
	for line in sys.stdin:
		line = line.strip()
		if not line:
			continue
		try:
			req = json.loads(line)
		except ValueError:
			continue
		try:
			if not bridge.handle(req):
				break
		except Exception as e:
			emit({'ev': 'fatal', 'message': str(e)})
	bridge.stop()
	return 0


def main(argv):
	try:
		if len(argv) >= 1 and argv[0] == 'list':
			list_specs()
			return 0
		if len(argv) >= 2 and argv[0] == 'run':
			return run(argv[1])
	except ImportError as e:
		emit({'ev': 'fatal', 'message': 'jupyter_client is not installed: %s' % e, 'missing': True})
		return 2
	emit({'ev': 'fatal', 'message': 'usage: list | run <kernel>'})
	return 2


if __name__ == '__main__':
	sys.exit(main(sys.argv[1:]))
