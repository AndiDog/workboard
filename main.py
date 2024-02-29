#!/usr/bin/env python3
import json
import html
import http.server
import jinja2
import logging
import os
import socketserver
import subprocess
import sys
import threading
import time
import traceback
import yaml

PORT = 16666


class ServerHandler(http.server.SimpleHTTPRequestHandler):
    # Must be set class-wide from configuration files (read-only)
    github_user = None
    website_template = None

    def do_GET(self):
        if self.path == '/favicon.ico':
            self.send_response(404)
            self.end_headers()
            return

        if self.path != '/':
            raise RuntimeError(f'This app has only URL path `/` (not {self.path!r})')

        try:
            my_pull_requests = json.loads(subprocess.check_output([
                'gh',
                'search', 'prs',
                '--author', self.github_user,
                '--state', 'open',
                '--json', 'url,title,repository'
            ], encoding='utf-8'))

            data = {
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



def main():
    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s %(levelname)-8s %(message)s',
    )

    # Load config from file
    config_file_path = 'github-pr-board.yaml'
    config_file_example_path = 'github-pr-board.yaml.example'
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
