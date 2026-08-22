class SdkError(Exception):
    def __init__(self, code: str, status: int, request_id: str, message: str):
        super().__init__(message)
        self.code, self.status, self.request_id = code, status, request_id
