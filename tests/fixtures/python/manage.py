import os
import sys

from django.conf import settings

settings.configure(
    DEBUG=False,
    SECRET_KEY="uterm-isolated-test-fixture",
    ROOT_URLCONF=__name__,
    ALLOWED_HOSTS=["127.0.0.1", "localhost", "[::1]"],
)

from django.http import JsonResponse
from django.urls import path

urlpatterns = [
    path("health", lambda request: JsonResponse({"status": "ok", "framework": "django", "value": os.environ.get("VALUE", "")})),
]

if __name__ == "__main__":
    from django.core.management import execute_from_command_line

    execute_from_command_line(sys.argv)
