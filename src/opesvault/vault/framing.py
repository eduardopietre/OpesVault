"""Binary framing for messages between the UI process and the vault worker.

A message is a JSON header validated by Pydantic plus raw binary blobs, so
document bytes travel without base64 inflation and nothing is unpickled.

Layout: MAGIC | u32 header_len | header | u32 blob_count | (u64 len | bytes)*
"""

import struct
from typing import IO

from pydantic import BaseModel, ValidationError

from opesvault.vault.errors import ErrorCode, VaultError

MAGIC = b"OPV1"
MAX_HEADER_BYTES = 64 * 1024 * 1024
MAX_BLOB_COUNT = 100_000
MAX_BLOB_BYTES = 1024 * 1024 * 1024

_U32 = struct.Struct("<I")
_U64 = struct.Struct("<Q")


def write_message(stream: IO[bytes], header: BaseModel, blobs: tuple[bytes, ...] = ()) -> None:
    raw = header.model_dump_json().encode("utf-8")
    if len(raw) > MAX_HEADER_BYTES or len(blobs) > MAX_BLOB_COUNT:
        raise VaultError(ErrorCode.PROTOCOL_ERROR)
    stream.write(MAGIC)
    stream.write(_U32.pack(len(raw)))
    stream.write(raw)
    stream.write(_U32.pack(len(blobs)))
    for blob in blobs:
        if len(blob) > MAX_BLOB_BYTES:
            raise VaultError(ErrorCode.PROTOCOL_ERROR)
        stream.write(_U64.pack(len(blob)))
        stream.write(blob)
    stream.flush()


def _read_exact(stream: IO[bytes], n: int) -> bytes:
    chunks: list[bytes] = []
    remaining = n
    while remaining:
        chunk = stream.read(remaining)
        if not chunk:
            raise VaultError(ErrorCode.PROTOCOL_ERROR)
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def read_message[M: BaseModel](stream: IO[bytes], header_type: type[M]) -> tuple[M, tuple[bytes, ...]]:
    if _read_exact(stream, len(MAGIC)) != MAGIC:
        raise VaultError(ErrorCode.PROTOCOL_ERROR)
    (header_len,) = _U32.unpack(_read_exact(stream, _U32.size))
    if header_len > MAX_HEADER_BYTES:
        raise VaultError(ErrorCode.PROTOCOL_ERROR)
    try:
        header = header_type.model_validate_json(_read_exact(stream, header_len))
    except ValidationError:
        raise VaultError(ErrorCode.PROTOCOL_ERROR) from None
    (count,) = _U32.unpack(_read_exact(stream, _U32.size))
    if count > MAX_BLOB_COUNT:
        raise VaultError(ErrorCode.PROTOCOL_ERROR)
    blobs: list[bytes] = []
    for _ in range(count):
        (size,) = _U64.unpack(_read_exact(stream, _U64.size))
        if size > MAX_BLOB_BYTES:
            raise VaultError(ErrorCode.PROTOCOL_ERROR)
        blobs.append(_read_exact(stream, size))
    return header, tuple(blobs)
