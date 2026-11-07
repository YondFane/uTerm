import subprocess
import time
from pathlib import Path


def verify_disk_image(image, attempts):
    for number in range(1, 6):
        try:
            result = subprocess.run(['hdiutil', 'verify', str(image)], capture_output=True, timeout=60)
        except Exception as error:
            attempts.append(dict(attempt=number, passed=False, exception=str(error)))
            raise
        stderr = result.stderr.decode(errors='replace')
        attempts.append(dict(attempt=number, passed=result.returncode == 0,
                             exitCode=result.returncode, stdout=result.stdout.decode(errors='replace'), stderr=stderr))
        if result.returncode == 0:
            return
        # DiskImages can briefly retain its create lock; retry only explicit busy responses.
        # DiskImages 创建锁可能短暂保留；只重试明确的临时占用响应。
        temporary = any(message in stderr for message in ['Resource temporarily unavailable', 'Resource busy'])
        if not temporary or number == 5:
            raise RuntimeError(f'hdiutil verify failed ({result.returncode}): ' + stderr)
        time.sleep(number * 0.25)


def create_disk_image(source, image, volume, attempts):
    image = Path(image)
    if image.exists() or image.is_symlink():
        raise FileExistsError(f"Refusing to overwrite an existing image: {image}")
    for number in range(1, 6):
        try:
            result = subprocess.run(['hdiutil', 'create', '-quiet', '-volname', volume,
                                     '-srcfolder', str(source), '-format', 'UDZO', str(image)],
                                    capture_output=True, timeout=120)
        except Exception as error:
            attempts.append(dict(attempt=number, passed=False, exception=str(error)))
            raise
        stderr = result.stderr.decode(errors='replace')
        attempts.append(dict(attempt=number, passed=result.returncode == 0,
                             exitCode=result.returncode, stdout=result.stdout.decode(errors='replace'), stderr=stderr))
        if result.returncode == 0:
            return
        temporary = any(message in stderr for message in ['Resource temporarily unavailable', 'Resource busy'])
        if not temporary or number == 5:
            raise RuntimeError(f'hdiutil create failed ({result.returncode}): ' + stderr)
        if image.is_symlink() or (image.exists() and not image.is_file()):
            raise RuntimeError('Image creation left an unexpected output type')
        # Only discard partial output owned by this creation attempt before a bounded busy retry.
        # 仅在有限的占用重试前清理本次创建所属的部分输出。
        image.unlink(missing_ok=True)
        time.sleep(number * 0.25)
