#!/usr/bin/env python3
import json
import os
import sys
import time
from pathlib import Path

root = Path(os.environ['UTERM_GITHUB_FIXTURE_ROOT'])
assert root.name.startswith('uterm-native-qa-') and root.is_dir()
arguments = sys.argv[1:]
assert os.environ['GH_HOST'] == 'github.com'
assert os.environ['GH_PROMPT_DISABLED'] == '1'
assert os.environ['GH_PAGER'] == 'cat'
assert 'GH_REPO' not in os.environ
repository = 'fixture-owner/fixture-repo'

def record(event, **values):
    with (root / 'github-cli.jsonl').open('a') as stream:
        stream.write(json.dumps(dict(event=event, arguments=arguments, **values)) + '\n')

record('called')
if (root / 'github-offline').exists():
    print('isolated GitHub fixture is offline', file=sys.stderr)
    sys.exit(1)
kind = arguments[0]
if kind == 'repo':
    print(json.dumps({'parent': None, 'defaultBranchRef': {'name': 'main'}}))
elif kind in ['issue', 'pr']:
    if (root / 'github-slow-read').exists():
        record('read-start'); (root / 'github-read-started').write_text('started')
        time.sleep(.6); record('read-completed')
    number = 7 if kind == 'issue' else 8
    item = dict(number=number, title='Native GitHub 中文', body='**BOLD_FIXTURE**\n\n<script>UNTRUSTED_SCRIPT</script>\n\n![remote](https://example.invalid/pixel)',
                url=f'https://github.com/{repository}/{"issues" if kind == "issue" else "pull"}/{number}',
                state='OPEN', author={'login': 'fixture-user'}, labels=[{'name': 'fixture'}], comments=[],
                files=[{'path': 'notes.txt', 'additions': 1, 'deletions': 0}], headRefName='qa-feature', baseRefName='main')
    if arguments[1] == 'diff':
        print('diff --git a/notes.txt b/notes.txt\n+GITHUB_FIXTURE_DIFF')
    else:
        print(json.dumps([item] if arguments[1] == 'list' else item))
elif kind == 'api':
    assert arguments[:5] == ['api', '--hostname', 'github.com', '--method', 'POST']
    assert arguments[5] == f'repos/{repository}/pulls'
    payload = json.loads(Path(arguments[arguments.index('--input') + 1]).read_text())
    assert set(payload) == {'title', 'body', 'base', 'head', 'draft'}
    record('create-start', payload=payload)
    (root / 'github-create-started').write_text('started')
    time.sleep(2)
    record('create-completed', payload=payload)
    print(json.dumps({'number': 99, 'html_url': f'https://github.com/{repository}/pull/99'}))
else:
    raise AssertionError(arguments)
