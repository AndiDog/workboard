#!/usr/bin/env python3
import copy
import json
import html
import http.server
import jinja2
import logging
import os
import random
import socketserver
import string
import subprocess
import sys
import threading
import time
import traceback
from urllib.parse import parse_qsl
import yaml

PORT = 16666


class PullRequestStatus:
    SNOOZED = 'snoozed'
    UNKNOWN = 'unknown'


class ServerHandler(http.server.SimpleHTTPRequestHandler):
    # Must be set class-wide from configuration files (read-only)
    github_user = None
    db_file_path = None
    website_template = None

    # Class-wide state
    last_csrf_tokens = []

    def _fill_pr_fields_from_db(self, pr, db):
        pr_by_url = db.setdefault('pull_requests', {}).setdefault(pr['url'], {})
        pr_by_url.setdefault('status', PullRequestStatus.UNKNOWN)
        pr = copy.deepcopy(pr)
        pr.setdefault('db', {})
        pr['db'] = pr_by_url
        return pr

    def _read_db(self):
        with open(self.db_file_path) as f:
            db = yaml.safe_load(f)
        if db is None:
            logging.warning('Database is empty (assuming this is a first-time startup)')
            db = {}
        return db

    def _write_db(self, db):
        with open(self.db_file_path, 'r+') as out:
            yaml.safe_dump(db, out)
            out.truncate()

    def do_GET(self):
        if self.path == '/favicon.ico':
            self.send_response(404)
            self.end_headers()
            return

        if self.path != '/':
            raise RuntimeError(f'This app has only URL path `/` (not {self.path!r})')

        try:
            db = self._read_db()

            my_pull_requests = json.loads(subprocess.check_output([
                'gh',
                'search', 'prs',
                '--author', self.github_user,
                '--state', 'open',
                '--json', 'repository,updatedAt,url,title'
            ], encoding='utf-8'))

            my_pull_requests = list(self._fill_pr_fields_from_db(pr, db) for pr in my_pull_requests)

            csrf_token = ''.join(random.choice(string.ascii_letters + string.digits) for _ in range(100))
            self.last_csrf_tokens.append(csrf_token)
            del self.last_csrf_tokens[0:max(0, len(self.last_csrf_tokens) - 10)]  # expire old ones

            data = {
                'csrf_token': csrf_token,
                'github_user': self.github_user,
                'my_pull_requests': my_pull_requests,
            }
            res = self.website_template.render(data, undefined=jinja2.StrictUndefined).encode('utf-8')

            self._write_db(db)

            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.end_headers()
            self.wfile.write(res)
        except Exception:
            self.send_response(500)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.end_headers()

            self.wfile.write(f'''
                <html><body>
                <h1 style="color: red">Error</h1>
                <pre>
                {html.escape(traceback.format_exc())}
                </pre>
                </body></html>
            '''.encode('utf-8'))

    def _get_protected_post_params(self):
        params = dict(parse_qsl(self.rfile.read(int(self.headers['Content-Length'])).decode('ascii')))
        if params['csrf_token'] not in self.last_csrf_tokens:
            raise RuntimeError('Invalid or expired CSRF token (could be an attack)')
        return params

    def do_POST(self):
        if self.path == '/pr/snooze':
            params = self._get_protected_post_params()

            pr_url = params['pr_url']
            if not isinstance(pr_url, str) or len(pr_url) > 300:
                raise ValueError('Invalid pr_url')

            # Format `2023-12-01T10:45:55Z`
            snooze_until_updated_at_changed_from = params['current_updated_at']
            if (not isinstance(snooze_until_updated_at_changed_from, str)
                    or len(snooze_until_updated_at_changed_from) > 30):
                raise ValueError('Invalid current_updated_at')

            db = self._read_db()
            pr_by_url = db['pull_requests'][pr_url]
            pr_by_url['status'] = PullRequestStatus.SNOOZED
            pr_by_url['snooze_until_updated_at_changed_from'] = snooze_until_updated_at_changed_from
            self._write_db(db)

            logging.info(
                'Snoozing PR %r until updatedAt changed away from %r', pr_url, snooze_until_updated_at_changed_from)

            # Back to homepage (full reload - yes this is a very simple web app!)
            self.send_response(303)
            self.send_header('Location', '/')
            self.end_headers()
        else:
            self.send_response(404)
            self.end_headers()


def main():
    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s %(levelname)-8s %(message)s',
    )

    # Load config from file
    config_file_path = os.path.abspath('github-pr-board.yaml')
    config_file_example_path = os.path.abspath('github-pr-board.yaml.example')
    if not os.path.exists(config_file_path):
        raise RuntimeError(
            f'Please add a configuration file {config_file_path!r}. '
            f'You can copy-paste from {config_file_example_path!r}')
    with open(config_file_path) as f:
        cfg = yaml.safe_load(f)
    def get_cfg_path(*path):
        current = cfg
        message = ''
        for p in path:
            message = message + ('.' if message else '') + p
            if p not in current:
                raise RuntimeError(
                    f'Config file {config_file_path!r} is missing key {message!r}. '
                    f'Please check in {config_file_example_path!r} what it should look like.')
            current = current[p]
        return current
    ServerHandler.github_user = get_cfg_path('github', 'user')

    ServerHandler.db_file_path = os.path.abspath('github-pr-board.db')
    if not os.path.exists(ServerHandler.db_file_path):
            raise RuntimeError(
                f'Please create {ServerHandler.db_file_path!r} if this is the first time starting this '
                'application. Not the first time? The file cannot be found and this is a hard error.')

    with open('main.html.j2') as f:
        ServerHandler.website_template = jinja2.Template(f.read())

    httpd = socketserver.TCPServer(('localhost', PORT), ServerHandler, bind_and_activate=False)
    httpd.allow_reuse_address = True
    httpd.server_bind()
    httpd.server_activate()

    logging.info('Serving at port %d', PORT)
    httpd.serve_forever()


if __name__ == '__main__':
    sys.exit(main())
