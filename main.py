#!/usr/bin/env python3
import copy
import json
import html
import http.server
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

import diskcache
import jinja2
import yaml


PORT = 16666


class PullRequestStatus:
    SNOOZED = 'snoozed'
    UNKNOWN = 'unknown'


class ServerHandler(http.server.SimpleHTTPRequestHandler):
    # Must be set class-wide from configuration files (read-only)
    cache = None
    github_user = None
    website_template = None

    # Class-wide state
    last_csrf_tokens = []

    def _cached_subprocess_check_output(self, cache_key, duration_seconds, mutate_before_store_in_cache=None, *args, **kwargs):
        with self.db.transact():
            value = self.db.get(cache_key)
            if value is not None:
                logging.debug('Using cached value for key %r instead of running process')
                return value

            value = subprocess.check_output(*args, **kwargs)
            if mutate_before_store_in_cache is not None:
                value = mutate_before_store_in_cache(value)
            self.db.set(cache_key, value, expire=duration_seconds)

        return value

    def _fill_pr_fields_from_db(self, github_pr):
        with self.db.transact():
            # Set defaults if keys don't exist
            self.db.add('pull_requests', {})

            pull_requests = self.db.get('pull_requests', {})
            if not pull_requests:
                logging.debug('Database has no pull requests yet')
            pr_stored = pull_requests.setdefault(github_pr['url'], {})
            pr_stored.setdefault('status', PullRequestStatus.UNKNOWN)

            # Add database values as `stored` field. This is used for rendering and other purposes.
            pr = copy.deepcopy(github_pr)
            pr.setdefault('stored', {})
            pr['stored'] = pr_stored

            self._update_pr(pr)
            self.db.set('pull_requests', pull_requests)

            return pr

    def _update_pr(self, pr):
        # TODO
        return

    def do_GET(self):
        if self.path == '/favicon.ico':
            self.send_response(404)
            self.end_headers()
            return

        if self.path != '/':
            raise RuntimeError(f'This app has only URL path `/` (not {self.path!r})')

        try:
            my_pull_requests = self._cached_subprocess_check_output(
                f'subprocess.prs.{self.github_user}.v1',
                600,
                lambda v: json.loads(v),

                [
                    'gh',
                    'search', 'prs',
                    '--author', self.github_user,
                    '--state', 'open',
                    '--json', 'repository,updatedAt,url,title'
                ],
                encoding='utf-8',
            )

            my_pull_requests = list(self._fill_pr_fields_from_db(pr) for pr in my_pull_requests)

            csrf_token = ''.join(random.choice(string.ascii_letters + string.digits) for _ in range(100))
            self.last_csrf_tokens.append(csrf_token)
            del self.last_csrf_tokens[0:max(0, len(self.last_csrf_tokens) - 10)]  # expire old ones

            data = {
                'csrf_token': csrf_token,
                'github_user': self.github_user,
                'my_pull_requests': my_pull_requests,
            }
            res = self.website_template.render(data, undefined=jinja2.StrictUndefined).encode('utf-8')

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

            with self.db.transact():
                pull_requests = self.db['pull_requests']
                pr = pull_requests[pr_url]
                pr['status'] = PullRequestStatus.SNOOZED
                pr['snooze_until_updated_at_changed_from'] = snooze_until_updated_at_changed_from
                self.db.set('pull_requests', pull_requests)

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
    config_file_path = os.path.abspath('workboard.yaml')
    config_file_example_path = os.path.abspath('workboard.yaml.example')
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

    db_dir = os.path.abspath('workboard.db')
    if not os.path.exists(db_dir):
        raise RuntimeError(
            f'Please create the database directory {db_dir!r} if this is the first time '
            'starting this application. Not the first time? The directory cannot be found and this is a hard error.')

    with open('main.html.j2') as f:
        ServerHandler.website_template = jinja2.Template(f.read())

    # The diskcache module uses a directory for the cache
    ServerHandler.cache = diskcache.Cache(os.path.abspath('workboard.cache'))
    ServerHandler.db = diskcache.Cache(os.path.abspath('workboard.db'))

    if len(ServerHandler.db) == 0:
        logging.warning(f'Database {db_dir!r} is empty (assuming this is a first-time startup)')
        ServerHandler.db.set('initialized', True, expire=None)

    httpd = socketserver.TCPServer(('localhost', PORT), ServerHandler, bind_and_activate=False)
    httpd.allow_reuse_address = True
    httpd.server_bind()
    httpd.server_activate()

    try:
        logging.info('Serving at port %d', PORT)
        httpd.serve_forever()
    finally:
        ServerHandler.db.close()
        ServerHandler.cache.close()

if __name__ == '__main__':
    sys.exit(main())
