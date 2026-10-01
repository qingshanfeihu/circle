"""Discovery boundaries, persisted URLs and manual configuration; no live services."""
import json
from types import SimpleNamespace

import pytest

import circle.probe as probe
from circle.init_flow import complete_api_key_init, _init_api_key
from circle.settings import CircleSettings, ModelAuth, load_settings, save_credentials
from circle.tui.controllers import InitController, InitStep


@pytest.mark.parametrize('payload', [{}, {'error': 'denied'}, [], None,
                                      {'data': None}, {'data': 1}, {'data': {}},
                                      {'data': [{'id': 42}]}, {'data': [{'id': ''}]},
                                      {'data': [None]}, {'data': [{'id': '   '}]}])
def test_invalid_payload_is_failure_without_models(monkeypatch, payload):
    monkeypatch.setattr(probe, '_get', lambda *a: (200, json.dumps(payload).encode()))
    result = probe.resolve_endpoint('https://gateway.example/v1', 'dummy')
    assert result.status == 'failed'
    assert result.inferred and result.models == []
    assert 'invalid model list' in result.summary()


@pytest.mark.parametrize('body', [b'not json', b'\xff'])
def test_invalid_json_is_failure(monkeypatch, body):
    monkeypatch.setattr(probe, '_get', lambda *a: (200, body))
    assert probe.resolve_endpoint('https://gateway.example', 'dummy').status == 'failed'


def test_empty_does_not_mask_other_protocol(monkeypatch):
    def get(url, headers, timeout):
        return 200, json.dumps({'data': [{'id': 'real-model'}] if 'x-api-key' in headers else []}).encode()
    monkeypatch.setattr(probe, '_get', get)
    result = probe.resolve_endpoint('https://gateway.example/v1', 'dummy')
    assert result.protocol == 'anthropic'
    assert result.models == ['real-model']
    assert result.base_url == 'https://gateway.example'


@pytest.mark.parametrize('base', ['https://api.stepfun.com', 'https://api.stepfun.ai',
                                  'https://gateway.example/prefix', 'https://gateway.example/prefix/v1/'])
def test_openai_root_and_versioned_base_preserve_host_and_prefix(monkeypatch, tmp_path, base):
    canonical = base.rstrip('/')
    if not canonical.endswith('/v1'):
        canonical += '/v1'
    calls = []
    def get(url, headers, timeout):
        calls.append((url, headers))
        if url == canonical + '/models' and 'Authorization' in headers:
            return 200, b'{"object":"list","data":[{"id":"server-model"}]}'
        return 404, b'{}'
    monkeypatch.setattr(probe, '_get', get)
    settings = complete_api_key_init(base_url=base, api_key='dummy', home=tmp_path)
    assert settings.auth.base_url == canonical
    assert settings.auth.model == 'server-model'
    assert settings.auth.protocol == 'openai'
    assert load_settings(tmp_path).auth.base_url == canonical
    assert all('Authorization' in headers for _, headers in calls)


@pytest.mark.parametrize('base', ['https://gateway.example/apps/anthropic',
                                  'https://gateway.example/apps/anthropic/v1/'])
def test_anthropic_never_duplicates_v1(monkeypatch, base):
    calls = []
    def get(url, headers, timeout):
        calls.append(url)
        assert 'x-api-key' in headers
        return 200, b'{"data":[{"id":"server-model"}]}'
    monkeypatch.setattr(probe, '_get', get)
    result = probe.resolve_endpoint(base, 'dummy')
    assert calls == ['https://gateway.example/apps/anthropic/v1/models']
    assert result.base_url == 'https://gateway.example/apps/anthropic'


def test_deduplicates_ids_without_reordering(monkeypatch):
    monkeypatch.setattr(probe, '_get', lambda *a: (200, b'{"data":[{"id":"b"},{"id":"a"},{"id":"b"}]}'))
    assert probe.resolve_endpoint('https://gateway.example', 'dummy').models == ['b', 'a']


@pytest.mark.parametrize('base', ['not-a-url', 'ftp://gateway.example',
                                  'https://gateway.example?key=dummy', 'https://user:dummy@gateway.example',
                                  'https://gateway.example/#fragment', 'https://gateway.example:bad', 'http://['])
def test_invalid_bases_do_not_issue_requests(monkeypatch, base):
    def get(*args):
        pytest.fail('invalid URL must not be requested')
    monkeypatch.setattr(probe, '_get', get)
    assert probe.resolve_endpoint(base, 'dummy').status == 'failed'


@pytest.mark.parametrize('status', [401, 403, 404, 500])
def test_http_errors_are_safe_and_explicit(monkeypatch, status):
    import urllib.error
    def get(*args):
        raise urllib.error.HTTPError('https://gateway.example', status, 'secret body', {}, None)
    monkeypatch.setattr(probe, '_get', get)
    result = probe.resolve_endpoint('https://gateway.example', 'dummy')
    assert result.models == [] and result.status == 'failed'
    assert f'http {status}' in result.summary()
    assert 'secret' not in result.summary()


def init_controller(tmp_path):
    ctl = InitController(home=tmp_path)
    for text in ['1', 'https://gateway.example/v1', 'dummy']:
        ctl.submit_line(text)
    return ctl


def test_tui_empty_response_requires_manual_model(monkeypatch, tmp_path):
    monkeypatch.setattr(probe, '_get', lambda *a: (200, b'{"data":[]}'))
    ctl = init_controller(tmp_path)
    assert ctl.step == InitStep.PICK_MODEL and ctl.models == []
    assert 'empty model list' in '\n'.join(ctl.body_lines())
    ctl.confirm()
    assert not ctl.done and not (tmp_path / 'settings.json').exists()
    ctl.submit_line('my-model')
    assert ctl.done and ctl.settings.auth.model == 'my-model'


def test_tui_failure_requires_protocol_and_manual_model(monkeypatch, tmp_path):
    monkeypatch.setattr(probe, '_get', lambda *a: (401, b'{}'))
    ctl = init_controller(tmp_path)
    assert ctl.step == InitStep.MANUAL_PROTOCOL
    assert 'discovery failed' in '\n'.join(ctl.body_lines())
    ctl.submit_line('anthropic')
    assert ctl.step == InitStep.PICK_MODEL
    assert ctl.base_url == 'https://gateway.example'
    ctl.confirm()
    assert not ctl.done
    ctl.submit_line('my-model')
    assert load_settings(tmp_path).auth.protocol == 'anthropic'
    assert load_settings(tmp_path).auth.model == 'my-model'


def test_scripted_init_requires_explicit_values_when_discovery_fails(monkeypatch, tmp_path):
    monkeypatch.setattr(probe, '_get', lambda *a: (403, b'{}'))
    with pytest.raises(ValueError, match='specify both protocol and model'):
        complete_api_key_init(base_url='https://gateway.example', api_key='dummy', home=tmp_path)
    assert not (tmp_path / 'credentials.json').exists()
    result = complete_api_key_init(base_url='https://gateway.example/v1', api_key='dummy',
                                   model='manual-model', protocol='anthropic', home=tmp_path)
    assert result.auth.base_url == 'https://gateway.example'
    assert result.auth.model == 'manual-model'


def test_line_init_reports_empty_and_accepts_manual_model(monkeypatch, tmp_path, capsys):
    monkeypatch.setattr(probe, '_get', lambda *a: (200, b'{"data":[]}'))
    answers = iter(['https://gateway.example/v1', '', 'manual-model'])
    monkeypatch.setattr('builtins.input', lambda *a: next(answers))
    monkeypatch.setattr('getpass.getpass', lambda *a: 'dummy')
    settings = _init_api_key(home=tmp_path)
    assert settings.auth.model == 'manual-model'
    assert 'empty model list' in capsys.readouterr().out


def test_session_models_honors_saved_protocol_and_returns_no_fallback(monkeypatch, tmp_path):
    from circle.tui.session_app import CircleSessionApp
    save_credentials({'api_key': 'dummy'}, tmp_path)
    calls = []
    def get(url, headers, timeout):
        calls.append((url, headers))
        return 200, b'{"data":[]}'
    monkeypatch.setattr(probe, '_get', get)
    app = SimpleNamespace(home=tmp_path, settings=CircleSettings(
        auth=ModelAuth(protocol='anthropic', base_url='https://gateway.example/v1', model='current')))
    result = CircleSessionApp._list_models(app)
    assert result.status == 'empty' and result.models == []
    assert len(calls) == 1
    assert calls[0][0] == 'https://gateway.example/v1/models'
    assert 'x-api-key' in calls[0][1]


@pytest.mark.parametrize('protocol,base,expected_path', [
    ('openai', 'https://gateway.example/prefix/v1', '/prefix/v1/models'),
    ('anthropic', 'https://gateway.example/prefix/v1', '/prefix/v1/models'),
])
def test_normalized_base_matches_sdk_request_path(protocol, base, expected_path):
    import httpx
    from openai import OpenAI
    from anthropic import Anthropic
    from anthropic import _base_client as anthropic_transport
    if protocol == "anthropic" and hasattr(anthropic_transport, "httpx2"):
        httpx = anthropic_transport.httpx2
    requests = []
    def handle(request):
        requests.append(request)
        return httpx.Response(200, json={'data': [], 'object': 'list', 'has_more': False})
    client_type = OpenAI if protocol == 'openai' else Anthropic
    with client_type(api_key='dummy', base_url=probe.normalize_base_url(base, protocol),
                     http_client=httpx.Client(transport=httpx.MockTransport(handle))) as client:
        client.models.list()
    assert len(requests) == 1
    assert requests[0].url.path == expected_path
    assert requests[0].url.host == 'gateway.example'


@pytest.mark.parametrize('status,body,expected', [
    (200, b'{"data":[]}', 'empty model list'),
    (401, b'{}', 'discovery failed'),
    (200, b'{"data":[{"id":"server-model"}]}', 'discovered 1 models'),
])
@pytest.mark.parametrize('palette', ['dark', 'light'])
def test_models_command_reports_result_in_both_themes(monkeypatch, tmp_path, status, body, expected, palette):
    from circle.ink import theme
    from tests.test_slash_behaviors import _app, _snap
    saved = theme._detected
    try:
        theme.set_detected(*(theme.DEFAULT_DARK if palette == 'dark' else theme.DEFAULT_LIGHT), {})
        theme.apply_theme('auto')
        app = _app(tmp_path, monkeypatch)
        monkeypatch.setattr(probe, '_get', lambda *a: (status, body))
        app._cmd_models('')
        shown = _snap(app)
        assert expected in shown
        assert 'gpt-4.1' not in shown and 'claude-sonnet-4-5' not in shown
        if status == 200 and b'server-model' in body:
            assert 'server-model' in shown
    finally:
        theme._detected = saved
        theme.reset_palette()


@pytest.mark.parametrize('palette', ['dark', 'light'])
def test_init_manual_protocol_keyboard_confirmation(monkeypatch, tmp_path, palette):
    from circle.ink import theme
    from circle.ink.parse_keypress import KeyPress
    from circle.tui.app import CircleApp
    saved = theme._detected
    try:
        theme.set_detected(*(theme.DEFAULT_DARK if palette == 'dark' else theme.DEFAULT_LIGHT), {})
        theme.apply_theme('auto')
        monkeypatch.setattr(probe, '_get', lambda *a: (401, b'{}'))
        app = CircleApp(workspace=tmp_path, home=tmp_path / 'home')
        app.init = init_controller(tmp_path / 'home')
        app._rebuild()
        assert app.init.step == InitStep.MANUAL_PROTOCOL
        app._on_input(KeyPress(key='down'))
        app._on_input(KeyPress(key='enter'))
        assert app.init.step == InitStep.PICK_MODEL
        assert app.init.protocol == 'anthropic'
        app._on_input(KeyPress(key='enter'))
        assert not app.init.done
        app._on_submit('manual-model')
        assert app.init.done
    finally:
        theme._detected = saved
        theme.reset_palette()


def test_line_failure_requires_protocol_before_model(monkeypatch, tmp_path, capsys):
    monkeypatch.setattr(probe, '_get', lambda *a: (401, b'{}'))
    answers = iter(['https://gateway.example/v1', '2', 'manual-model'])
    monkeypatch.setattr('builtins.input', lambda *a: next(answers))
    monkeypatch.setattr('getpass.getpass', lambda *a: 'dummy')
    settings = _init_api_key(home=tmp_path)
    assert settings.auth.protocol == 'anthropic'
    assert settings.auth.base_url == 'https://gateway.example'
    assert 'discovery failed' in capsys.readouterr().out


def test_scripted_empty_requires_model_before_saving(monkeypatch, tmp_path):
    monkeypatch.setattr(probe, '_get', lambda *a: (200, b'{"data":[]}'))
    with pytest.raises(ValueError, match='no models discovered'):
        complete_api_key_init(base_url='https://gateway.example/v1', api_key='dummy', home=tmp_path)
    assert not (tmp_path / 'credentials.json').exists()
