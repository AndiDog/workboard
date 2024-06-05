#!/usr/bin/env python3
import copy
import datetime
import doctest
from enum import StrEnum
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
import timeago
import yaml


PORT = 16666


class PullRequestStatus(StrEnum):
    # When adding new status values here, ensure amending all code that tries to handle every value
    # (e.g. CSS classes).

    CLOSED = 'closed'
    DELETED = 'deleted'
    MERGED = 'merged'
    MUST_REVIEW = 'must-review'

    # User reviewed/updated the PR, and either merged it or expects it to be merged. If that happens, it should
    # be deleted from workboard storage. If not, it should pop up again (TODO this part isn't implemented yet).
    REVIEWED_DELETE_ON_MERGE = 'reviewed-delete-on-merge'

    # Basically means that someone else takes care of the review. Only makes sense for PRs authored by others.
    SNOOZED_UNTIL_MENTIONED = 'snoozed-until-mentioned'

    SNOOZED_UNTIL_TIME = 'snoozed-until-time'
    SNOOZED_UNTIL_UPDATE = 'snoozed-until-update'
    UPDATED_AFTER_SNOOZE = 'updated-after-snooze'
    UNKNOWN = 'unknown'

PR_STATUS_SORT_ORDER = {
    str(PullRequestStatus.CLOSED): 1,
    str(PullRequestStatus.DELETED): 999,  # not applicable since we filter those out for rendering
    str(PullRequestStatus.MERGED): 1,
    str(PullRequestStatus.MUST_REVIEW): 2,
    str(PullRequestStatus.REVIEWED_DELETE_ON_MERGE): 5,
    str(PullRequestStatus.SNOOZED_UNTIL_MENTIONED): 5,
    str(PullRequestStatus.SNOOZED_UNTIL_TIME): 5,
    str(PullRequestStatus.SNOOZED_UNTIL_UPDATE): 5,
    str(PullRequestStatus.UPDATED_AFTER_SNOOZE): 1,
    str(PullRequestStatus.UNKNOWN): 4,
}
assert all(str(status) in PR_STATUS_SORT_ORDER for status in PullRequestStatus), \
    'All PullRequestStatus enum values must be represented in PR_STATUS_SORT_ORDER'


def github_datetime_to_timestamp(s):
    """
    >>> github_datetime_to_timestamp('2023-12-01T10:45:55Z')
    1701427555
    >>> github_datetime_to_timestamp('2023-12-01T10:45:55ABC')  # doctest: +ELLIPSIS
    Traceback (most recent call last):
    ...
    ValueError: ...
    """

    return int(datetime.datetime.strptime(s, '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=datetime.timezone.utc).timestamp())


class ServerHandler(http.server.SimpleHTTPRequestHandler):
    # Must be set class-wide from configuration files (read-only)
    cache = None
    github_user = None
    website_template = None

    def _add_render_only_fields(self, pr):
        pr = copy.deepcopy(pr)
        pr['render_only_fields'] = {
            'author_is_self': pr['github_fields']['author']['login'] == self.github_user,
            'last_updated_desc': timeago.format(
                datetime.datetime.fromtimestamp(github_datetime_to_timestamp(pr['github_fields']['updatedAt'])),
                locale='en'),
        }
        return pr

    def _cached_subprocess_check_output(self, *, cache_key, cache_duration_seconds, use_cache=True, mutate_before_store_in_cache=None, subprocess_kwargs):
        with self.cache.transact():
            if use_cache:
                value = self.cache.get(cache_key)
                if value is not None:
                    logging.debug(
                        'Using cached value for command output of cache key %r (cache duration: %s)',
                        cache_key,
                        cache_duration_seconds)
                    return value
            else:
                logging.debug('Avoiding read from cache for cache key %r', cache_key)
                self.cache.pop(cache_key)

            logging.debug('Running command for cache key %r (cache duration: %ds)', cache_key, cache_duration_seconds)
            proc = subprocess.Popen(**subprocess_kwargs, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            (stdout, stderr) = proc.communicate()
            if proc.returncode:
                raise RuntimeError(f'Command failed for cache key {cache_key!r}. Error output was: {stderr!r}')
            value = stdout
            if mutate_before_store_in_cache is not None:
                value = mutate_before_store_in_cache(value)
            if use_cache:
                self.cache.set(cache_key, value, expire=cache_duration_seconds)

        return value

    def _fetch_remaining_github_pr_fields(self, github_pr, use_cache=True):
        """
        Since the search API doesn't support all fields, such as `merged`, we fetch those separately.

        This function may be called on `gh search prs` items, but also on database items, such as PRs which are
        merged/closed by now and therefore aren't returned by our `gh search prs` command lines. It must behave
        reasonably on database items: those might have outdated information, so we fetch all fields again to ensure
        everything is up to date with the actual values in GitHub.
        """

        updated_seconds_ago = abs(time.time() - github_datetime_to_timestamp(github_pr['updatedAt']))
        # Cache for longer if last update of PR is long ago
        if updated_seconds_ago > 86400 * 365:
            cache_duration_seconds = 14400
        elif updated_seconds_ago > 86400 * 7:
            cache_duration_seconds = 3600
        elif updated_seconds_ago > 86400 * 2:
            cache_duration_seconds = 1800
        else:
            cache_duration_seconds = 600

        extra_fields_json_arg = 'author,closed,state,updatedAt,title'
        extra_fields = self._cached_subprocess_check_output(
            cache_key=f'subprocess.pr.{github_pr["url"]}.{extra_fields_json_arg}',
            cache_duration_seconds=cache_duration_seconds,
            mutate_before_store_in_cache=lambda v: json.loads(v),
            use_cache=use_cache and not self.db.get(f'avoid-cache.{github_pr["url"]}'),
            subprocess_kwargs=dict(
                args=[
                    'gh',
                    'pr',
                    'view',
                    github_pr['url'],
                    '--json', extra_fields_json_arg,
                ],
                encoding='utf-8',
            ),
        )

        github_pr = copy.deepcopy(github_pr)
        github_pr.update(extra_fields)
        return github_pr

    def _refetch_and_store_github_pr(self, pr_url):
        """
        Refetch PR without reading stale value from cache.

        This only refetches fields requested in `_fetch_remaining_github_pr_fields`, such as `updatedAt`!
        """
        with self.db.transact():
            github_pr = self.db['pull_requests'][pr_url]['github_fields']
            github_pr = self._fetch_remaining_github_pr_fields(github_pr, use_cache=False)
            self._update_db_from_github_pr(github_pr)

    def _update_db_from_github_pr(self, github_pr):
        with self.db.transact():
            # GitHub PR URL => {'github_fields': {...}, 'workboard_fields': {...}}
            pull_requests = self.db.get('pull_requests', {})

            if not pull_requests:
                logging.debug('Database has no pull requests')

            pr = pull_requests.setdefault(github_pr['url'], {})
            pr['github_fields'] = copy.deepcopy(github_pr)
            pr.setdefault('workboard_fields', {})

            # These are the only available fields of ours if PR is inserted the first time
            pr['workboard_fields'].setdefault('status', PullRequestStatus.UNKNOWN)
            pr['workboard_fields'].setdefault('last_change', github_datetime_to_timestamp(github_pr['updatedAt']))

            self._update_status_from_github_pr(pr, github_pr)

            if (pr['workboard_fields']['status'] == PullRequestStatus.DELETED
                    and pr['workboard_fields']['delete_after'] <= time.time()):
                logging.info('Deleting PR %r from database', github_pr['url'])
                del pull_requests[github_pr['url']]

            self._validate_pull_requests(pull_requests)
            self.db.set('pull_requests', pull_requests)

    def _update_status_from_github_pr(self, pr, github_pr):
        # See GitHub PR fields https://docs.github.com/en/graphql/reference/objects#pullrequest.
        # If any new fields are required here, add them to our `gh search prs [...] --json` command or it won't
        # be fetched.

        # Migrations from renames/refactoring
        if (pr['workboard_fields']['status'] == 'snoozed'
                and pr['workboard_fields'].get('snooze_until_updated_at_changed_from')):
            logging.info('Migrating `snoozed` status value for PR %r', github_pr['url'])
            pr['workboard_fields']['status'] = PullRequestStatus.SNOOZED_UNTIL_UPDATE

        if (pr['workboard_fields']['status'] not in (PullRequestStatus.DELETED, PullRequestStatus.MERGED)
                and github_pr['state'].lower() == 'merged'
                and github_pr['closed']):
            if pr['workboard_fields']['status'] == PullRequestStatus.REVIEWED_DELETE_ON_MERGE:
                logging.info('Marking PR %r as deleted because it was merged', github_pr['url'])
                pr['workboard_fields']['status'] = PullRequestStatus.DELETED
                pr['workboard_fields']['last_change'] = time.time()
                pr['workboard_fields']['delete_after'] = time.time() + 86400 * 30
            else:
                logging.info('Marking PR %r as merged', github_pr['url'])
                pr['workboard_fields']['status'] = PullRequestStatus.MERGED
                pr['workboard_fields']['last_change'] = time.time()

        if (pr['workboard_fields']['status'] == PullRequestStatus.REVIEWED_DELETE_ON_MERGE
                and pr['workboard_fields']['bring_back_to_review_if_not_merged_until'] <= time.time()):
            logging.info('Passed the time until PR %r was meant to be merged, marking as must-review', github_pr['url'])
            pr['workboard_fields']['status'] = PullRequestStatus.MUST_REVIEW
            pr['workboard_fields']['last_change'] = time.time()
            del pr['workboard_fields']['bring_back_to_review_if_not_merged_until']

        if (pr['workboard_fields']['status'] not in (PullRequestStatus.DELETED, PullRequestStatus.CLOSED)
                and github_pr['state'].lower() == 'closed'
                and github_pr['closed']):
            pr['workboard_fields']['status'] = PullRequestStatus.CLOSED
            pr['workboard_fields']['last_change'] = time.time()

        if (pr['workboard_fields']['status'] == PullRequestStatus.SNOOZED_UNTIL_TIME
                and pr['workboard_fields']['snooze_until'] <= time.time()):
            logging.info('Passed the time until PR %r was snoozed, unsnoozing it', github_pr['url'])
            pr['workboard_fields']['status'] = PullRequestStatus.MUST_REVIEW
            pr['workboard_fields']['last_change'] = time.time()
            del pr['workboard_fields']['snooze_until']

        if (pr['workboard_fields']['status'] == PullRequestStatus.SNOOZED_UNTIL_UPDATE
                and github_pr.get('updatedAt')
                and github_pr['updatedAt'] != pr['workboard_fields']['snooze_until_updated_at_changed_from']):
            logging.info(
                'Snoozed PR %r was updated between %r and %r, unsnoozing it',
                github_pr['url'], pr['workboard_fields']['snooze_until_updated_at_changed_from'], github_pr['updatedAt'])
            pr['workboard_fields']['status'] = PullRequestStatus.UPDATED_AFTER_SNOOZE
            pr['workboard_fields']['last_change'] = time.time()
            del pr['workboard_fields']['snooze_until_updated_at_changed_from']

    @staticmethod
    def _validate_pull_requests(pull_requests):
        # Some checks for logic errors (important until we use static typing checks)
        for url, pr in pull_requests.items():
            assert url.startswith('http')
            # `render_only_fields` not wanted in storage
            unwanted_fields = set(pr.keys()) - {'github_fields', 'workboard_fields'}
            assert not unwanted_fields, f'Unwanted fields in PR object: {unwanted_fields}'

    def do_GET(self):
        if self.path == '/favicon.ico':
            self.send_response(404)
            self.end_headers()
            return

        if self.path != '/':
            raise RuntimeError(f'This app has only URL path `/` (not {self.path!r})')

        try:
            already_updated_github_pr_urls = set()

            pr_search_json_fields_arg = 'author,repository,state,updatedAt,url,title'

            # Own PRs
            for github_pr in self._cached_subprocess_check_output(
                cache_key=f'subprocess.prs.own.{self.github_user}.{pr_search_json_fields_arg}',
                cache_duration_seconds=600,
                mutate_before_store_in_cache=lambda v: json.loads(v),
                subprocess_kwargs=dict(
                    args=[
                    'gh',
                    'search', 'prs',
                    '--author', self.github_user,
                    '--state', 'open',
                    '--json', pr_search_json_fields_arg
                ],
                encoding='utf-8',
                ),
            ):
                if github_pr['url'] in already_updated_github_pr_urls:
                    continue
                github_pr = self._fetch_remaining_github_pr_fields(github_pr)
                self._update_db_from_github_pr(github_pr)
                already_updated_github_pr_urls.add(github_pr['url'])

            # Assigned PRs
            for github_pr in self._cached_subprocess_check_output(
                cache_key=f'subprocess.prs.assigned.{self.github_user}.{pr_search_json_fields_arg}',
                cache_duration_seconds=600,
                mutate_before_store_in_cache=lambda v: json.loads(v),
                subprocess_kwargs=dict(
                    args=[
                    'gh',
                    'search', 'prs',
                    '--assignee', self.github_user,
                    '--state', 'open',
                    '--json', pr_search_json_fields_arg
                ],
                encoding='utf-8',
                ),
            ):
                if github_pr['url'] in already_updated_github_pr_urls:
                    continue
                github_pr = self._fetch_remaining_github_pr_fields(github_pr)
                self._update_db_from_github_pr(github_pr)
                already_updated_github_pr_urls.add(github_pr['url'])

            # Review requested PRs
            for github_pr in self._cached_subprocess_check_output(
                cache_key=f'subprocess.prs.review-requested.{self.github_user}.{pr_search_json_fields_arg}',
                cache_duration_seconds=600,
                mutate_before_store_in_cache=lambda v: json.loads(v),
                subprocess_kwargs=dict(
                    args=[
                    'gh',
                    'search', 'prs',
                    '--review-requested', self.github_user,
                    '--state', 'open',
                    '--json', pr_search_json_fields_arg
                ],
                encoding='utf-8',
                ),
            ):
                if github_pr['url'] in already_updated_github_pr_urls:
                    continue
                github_pr = self._fetch_remaining_github_pr_fields(github_pr)
                self._update_db_from_github_pr(github_pr)
                already_updated_github_pr_urls.add(github_pr['url'])

            pull_requests_from_db = self.db.get('pull_requests', {})
            missing_github_pr_urls = set(pull_requests_from_db.keys()) - already_updated_github_pr_urls
            # Only sorted to get the same behavior every time
            for github_pr in map(lambda pr_url: pull_requests_from_db[pr_url]['github_fields'], sorted(missing_github_pr_urls)):
                # PR could be closed/merged or otherwise not contained in the above queries. Since it's already in the
                # database, the user is interested in seeing updates, so we treat it like all others, of course.
                assert github_pr['url'] not in already_updated_github_pr_urls  # we loop through `missing_github_pr_urls`
                github_pr = self._fetch_remaining_github_pr_fields(github_pr)
                self._update_db_from_github_pr(github_pr)
                already_updated_github_pr_urls.add(github_pr['url'])

            pull_requests_to_render = sorted(
                map(
                    self._add_render_only_fields,
                    filter(
                        lambda pr: pr['workboard_fields']['status'] != PullRequestStatus.DELETED,
                        pull_requests_from_db.values(),
                    ),
                ),
                # PRs with latest changes are displayed on top, ordered by status.
                key=lambda pr: (
                    PR_STATUS_SORT_ORDER[pr['workboard_fields']['status']],
                    -github_datetime_to_timestamp(pr['github_fields']['updatedAt']),
                    -pr['workboard_fields'].get('last_change', 2**63),
                ),
            )

            csrf_token = ''.join(random.choice(string.ascii_letters + string.digits) for _ in range(100))
            self.cache.add(f'csrf.{csrf_token}', True, 14400)

            data = {
                'csrf_token': csrf_token,
                'github_user': self.github_user,
                'last_clicked_github_pr_url': self.db.get('last-clicked-github-pr-url'),
                'pull_requests': pull_requests_to_render,
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
                <pre>{html.escape(traceback.format_exc())}
                </pre>
                </body></html>
            '''.encode('utf-8'))

    def _get_protected_post_params(self):
        params = dict(parse_qsl(self.rfile.read(int(self.headers['Content-Length'])).decode('ascii')))
        if len(params['csrf_token']) != 100:
            raise RuntimeError('Invalid or expired CSRF token (could be an attack)')
        if not self.cache.get(f'csrf.{params["csrf_token"]}'):
            raise RuntimeError('Invalid or expired CSRF token (could be an attack)')
        return params

    def do_POST(self):
        if self.path == '/pr/clicked':
            params = self._get_protected_post_params()

            pr_url = params['pr_url']
            if not isinstance(pr_url, str) or len(pr_url) > 300:
                raise ValueError('Invalid pr_url')

            logging.info('Uncaching PR %r so the next few page reloads will fetch the latest updates each time', pr_url)

            with self.cache.transact():
                # Brute-force substring search, potentially matching unrelated cache keys, is good enough for the small
                # set of data that we expect in the cache storage
                cache_keys_to_delete = []
                for cache_key in self.cache:
                    if pr_url in cache_key:
                        cache_keys_to_delete.append(cache_key)
                for cache_key in cache_keys_to_delete:
                    logging.debug('Uncaching value for key %r for PR %r', cache_key, pr_url)
                    self.cache.pop(cache_key)

            with self.db.transact():
                self.db.set('last-clicked-github-pr-url', pr_url, expire=3600 * 4)
                self.db.set(f'avoid-cache.{pr_url}', True, expire=300)

            self.send_response(204)
            self.end_headers()

        elif self.path == '/pr/delete':
            params = self._get_protected_post_params()

            pr_url = params['pr_url']
            if not isinstance(pr_url, str) or len(pr_url) > 300:
                raise ValueError('Invalid pr_url')

            logging.info('Marking PR %r as deleted', pr_url)

            with self.db.transact():
                pull_requests = self.db['pull_requests']

                # We cannot simply remove the PR from `pull_requests` since a cached "list some PRs" command output
                # may re-add it. Instead, we simply update the status and remove the entry eventually.
                if pr_url not in pull_requests:
                    raise ValueError('PR not found, thus cannot be deleted')

                pr = pull_requests[pr_url]
                pr['workboard_fields']['status'] = PullRequestStatus.DELETED
                pr['workboard_fields']['last_change'] = time.time()
                pr['workboard_fields']['delete_after'] = time.time() + 86400 * 30
                self._validate_pull_requests(pull_requests)
                self.db.set('pull_requests', pull_requests)

            # Back to homepage (full reload - yes this is a very simple web app!)
            self.send_response(303)
            self.send_header('Location', '/')
            self.end_headers()
        elif self.path == '/pr/mark-must-review':
            params = self._get_protected_post_params()

            pr_url = params['pr_url']
            if not isinstance(pr_url, str) or len(pr_url) > 300:
                raise ValueError('Invalid pr_url')

            logging.info('Marking PR %r as must-review', pr_url)

            with self.db.transact():
                pull_requests = self.db['pull_requests']
                pr = pull_requests[pr_url]
                pr['workboard_fields']['status'] = PullRequestStatus.MUST_REVIEW
                pr['workboard_fields']['last_change'] = time.time()
                self._validate_pull_requests(pull_requests)
                self.db.set('pull_requests', pull_requests)
                self.db.set('last-clicked-github-pr-url', pr_url, expire=3600 * 4)

            # Back to homepage (full reload - yes this is a very simple web app!)
            self.send_response(303)
            self.send_header('Location', '/')
            self.end_headers()
        elif self.path == '/pr/reviewed-delete-on-merge':
            params = self._get_protected_post_params()

            pr_url = params['pr_url']
            if not isinstance(pr_url, str) or len(pr_url) > 300:
                raise ValueError('Invalid pr_url')

            logging.info('Marking PR %r as reviewed-delete-on-merge', pr_url)

            with self.db.transact():
                pull_requests = self.db['pull_requests']
                pr = pull_requests[pr_url]
                pr['workboard_fields']['status'] = PullRequestStatus.REVIEWED_DELETE_ON_MERGE
                pr['workboard_fields']['last_change'] = time.time()
                pr['workboard_fields']['bring_back_to_review_if_not_merged_until'] = time.time() + 3600 * 4
                self._validate_pull_requests(pull_requests)
                self.db.set('pull_requests', pull_requests)
                self.db.set('last-clicked-github-pr-url', pr_url, expire=3600 * 4)

            # Back to homepage (full reload - yes this is a very simple web app!)
            self.send_response(303)
            self.send_header('Location', '/')
            self.end_headers()
        elif self.path == '/pr/snooze-until-mentioned':
            params = self._get_protected_post_params()

            pr_url = params['pr_url']
            if not isinstance(pr_url, str) or len(pr_url) > 300:
                raise ValueError('Invalid pr_url')

            logging.info('Snoozing PR %r until user is mentioned', pr_url)

            with self.db.transact():
                pull_requests = self.db['pull_requests']
                pr = pull_requests[pr_url]
                pr['workboard_fields']['status'] = PullRequestStatus.SNOOZED_UNTIL_MENTIONED
                pr['workboard_fields']['last_change'] = time.time()
                self._validate_pull_requests(pull_requests)
                self.db.set('pull_requests', pull_requests)
                self.db.set('last-clicked-github-pr-url', pr_url, expire=3600 * 4)

            # Back to homepage (full reload - yes this is a very simple web app!)
            self.send_response(303)
            self.send_header('Location', '/')
            self.end_headers()
        elif self.path == '/pr/snooze-until-time':
            params = self._get_protected_post_params()

            pr_url = params['pr_url']
            if not isinstance(pr_url, str) or len(pr_url) > 300:
                raise ValueError('Invalid pr_url')

            logging.info('Snoozing PR %r for 1 day', pr_url)

            with self.db.transact():
                pull_requests = self.db['pull_requests']
                pr = pull_requests[pr_url]
                pr['workboard_fields']['status'] = PullRequestStatus.SNOOZED_UNTIL_TIME
                pr['workboard_fields']['last_change'] = time.time()
                pr['workboard_fields']['snooze_until'] = time.time() + 86400
                self._validate_pull_requests(pull_requests)
                self.db.set('pull_requests', pull_requests)
                self.db.set('last-clicked-github-pr-url', pr_url, expire=3600 * 4)

            # Back to homepage (full reload - yes this is a very simple web app!)
            self.send_response(303)
            self.send_header('Location', '/')
            self.end_headers()
        elif self.path == '/pr/snooze-until-update':
            params = self._get_protected_post_params()

            pr_url = params['pr_url']
            if not isinstance(pr_url, str) or len(pr_url) > 300:
                raise ValueError('Invalid pr_url')

            # The user may have just done something on the PR, such as triggering a test, commenting, leaving a review
            # comment or the like. Therefore, we need to update our stale `updatedAt` field in the database and only
            # want to return from snooze once another update happened after the user clicked the snooze button.
            # Format `2023-12-01T10:45:55Z`
            self._refetch_and_store_github_pr(pr_url)

            with self.db.transact():
                pull_requests = self.db['pull_requests']
                pr = pull_requests[pr_url]

                snooze_until_updated_at_changed_from = pr['github_fields']['updatedAt']
                logging.info(
                    'Snoozing PR %r until updatedAt changed away from %r', pr_url, snooze_until_updated_at_changed_from)

                pr['workboard_fields']['status'] = PullRequestStatus.SNOOZED_UNTIL_UPDATE
                pr['workboard_fields']['last_change'] = time.time()
                pr['workboard_fields']['snooze_until_updated_at_changed_from'] = snooze_until_updated_at_changed_from
                self._validate_pull_requests(pull_requests)
                self.db.set('pull_requests', pull_requests)
                self.db.set('last-clicked-github-pr-url', pr_url, expire=3600 * 4)

            # Back to homepage (full reload - yes this is a very simple web app!)
            self.send_response(303)
            self.send_header('Location', '/')
            self.end_headers()
        else:
            self.send_response(404)
            self.end_headers()


def main():
    logging.basicConfig(
        level=os.environ.get('LOGLEVEL', 'INFO').upper(),
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
        ServerHandler.website_template = jinja2.Template(f.read(), autoescape=True)

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
    if doctest.testmod()[0]:
        sys.exit(1)

    sys.exit(main())
