import json
from typing import Any, Optional
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from .errors import SdkError

class Client:
    def __init__(self, base_url: str, token: Optional[str] = None):
        self.base_url, self._token = base_url.rstrip('/'), token
    def request(self, path: str, method: str = 'GET', body=None):
        headers = {'Accept': 'application/json'}
        if self._token: headers['Authorization'] = f'Bearer {self._token}'
        data = None if body is None else json.dumps(body, separators=(',', ':')).encode()
        if data is not None: headers['Content-Type'] = 'application/json'
        try:
            with urlopen(Request(self.base_url + path, data=data, headers=headers, method=method)) as response:
                return json.loads(response.read().decode())
        except HTTPError as error:
            request_id = error.headers.get('x-request-id', '')
            try: payload = json.loads(error.read().decode())
            except Exception: payload = {}
            item = payload.get('error', {})
            raise SdkError(item.get('code', 'INTERNAL'), error.code, payload.get('request_id', request_id), item.get('message', 'request failed')) from None
    def health(self): return self.request('/api/v1/health')
    def status(self): return self.request('/api/v1/status')
