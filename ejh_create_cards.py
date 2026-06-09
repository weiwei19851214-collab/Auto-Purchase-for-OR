#!/usr/bin/env python3
"""
Single-file interactive EjiHui card creation script.

Required:
  pip install requests pycryptodome

Run:
  python ejh_create_cards.py
"""

from __future__ import annotations

import base64
import argparse
import csv
import getpass
import json
import os
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

import requests

AUTH_URL = "https://www.ejhcard.com/api/v3/authenticate"
CARD_URL = "https://www.ejhcard.com/api/v3/card"
API_VERSION = "3.0"
CREATE_CARD_METHOD = "card.open.info"
SUCCESS_CODES = {"0", "0000", "000000", "SUCCESS", "success"}

FIXED_CARD_TYPE = "MASTER_B1_1"
FIXED_CARD_CURRENCY = "USD"
FIXED_BILL_CURRENCY = "USD"
FIXED_USE_TIME = 1
FIXED_SUPPORTED_MCC_GROUP = "trv"
FIXED_COMPANY_RATE = "0.01"

OUTPUT_FIELDS = [
    "index",
    "success",
    "code",
    "msg",
    "orderNo",
    "cardNo",
    "validityDate",
    "cvvPassword",
    "cardType",
    "useTime",
    "cardAmount",
    "cardCurrency",
    "startTime",
    "endTime",
    "billAmount",
    "billCurrency",
    "bankRate",
    "actualBillAmount",
    "cardServiceFee",
    "currencyForexFee",
    "actualConvertedAmount",
    "supportedMccGroup",
    "status",
    "isLocked",
    "extInfoyx",
    "requestPayload",
    "encryptedParam",
    "rawResponse",
]

SAFE_OUTPUT_FIELDS = [
    "card_batch_id",
    "row_number",
    "card_provider",
    "card_product",
    "open_status",
    "error_code",
    "error_message",
    "order_no",
    "card_no",
    "pan_bin6",
    "pan_last4",
    "expiry_month",
    "expiry_year",
    "cvv",
    "card_amount",
    "card_currency",
    "bill_amount",
    "bill_currency",
    "active_date",
    "expires_at",
    "cardholder_ref",
    "ejh_status",
    "is_locked",
    "raw_provider_code",
    "created_at",
]


@dataclass(frozen=True)
class CardRequest:
    index: int
    payload: dict[str, Any]


def prompt_required(label: str, *, secret: bool = False) -> str:
    while True:
        value = getpass.getpass(label) if secret else input(label)
        value = value.strip()
        if value:
            return value
        print("输入不能为空，请重新输入。")


def prompt_positive_int(label: str) -> int:
    while True:
        raw = prompt_required(label)
        try:
            value = int(raw)
        except ValueError:
            print("请输入整数。")
            continue
        if value > 0:
            return value
        print("数量必须大于 0。")


def normalize_amount(raw: str) -> str:
    try:
        amount = Decimal(raw)
    except InvalidOperation as exc:
        raise SystemExit(f"金额格式不正确：{raw}") from exc
    if amount <= 0:
        raise SystemExit("金额必须大于 0。")
    return format(amount.quantize(Decimal("0.01")), "f")


def validate_date(raw: str) -> None:
    try:
        value = datetime.strptime(raw, "%Y-%m-%d").date()
    except ValueError as exc:
        raise SystemExit("到期时间格式必须是 yyyy-MM-dd，例如 2026-12-31。") from exc
    if value <= date.today():
        raise SystemExit("到期时间必须大于今天。")


def json_dumps(data: dict[str, Any]) -> str:
    return json.dumps(data, ensure_ascii=False, separators=(",", ":"))


def maybe_json_object(value: Any) -> Any:
    if not isinstance(value, str):
        return value
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return value


def load_pycryptodome() -> tuple[Any, Any] | None:
    try:
        from Crypto.Cipher import DES
        from Crypto.Util.Padding import pad
    except ImportError:
        return None
    return DES, pad


def encrypt_des_ecb_base64(data: str, app_secret: str) -> str:
    key = app_secret.encode("utf-8")
    if len(key) < 8:
        raise SystemExit("secret 长度不足，DES 至少需要 8 字节。")

    crypto = load_pycryptodome()
    if crypto:
        DES, pad = crypto
        cipher = DES.new(key[:8], DES.MODE_ECB)
        encrypted = cipher.encrypt(pad(data.encode("utf-8"), DES.block_size))
        return base64.b64encode(encrypted).decode("ascii")

    openssl = shutil.which("openssl")
    if not openssl:
        raise SystemExit("缺少 DES 加密依赖，请先执行：pip install pycryptodome")

    result = subprocess.run(
        [openssl, "enc", "-des-ecb", "-K", key[:8].hex(), "-nosalt", "-base64", "-A"],
        input=data.encode("utf-8"),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if result.returncode == 0:
        return result.stdout.decode("ascii").strip()

    result = subprocess.run(
        [
            openssl,
            "enc",
            "-des-ecb",
            "-provider",
            "legacy",
            "-provider",
            "default",
            "-K",
            key[:8].hex(),
            "-nosalt",
            "-base64",
            "-A",
        ],
        input=data.encode("utf-8"),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.decode("utf-8", errors="replace").strip())
    return result.stdout.decode("ascii").strip()


def authenticate(app_key: str, timeout: float = 30.0) -> str:
    response = requests.post(AUTH_URL, json={"appKey": app_key}, timeout=timeout)
    response.raise_for_status()
    body = response.json()
    data = maybe_json_object(body.get("data"))
    token = (data or {}).get("authToken") if isinstance(data, dict) else None
    if not token:
        raise RuntimeError(f"认证失败：{body}")
    return token


def build_card_requests(count: int, amount: str, active_date: str, cardholder: str) -> list[CardRequest]:
    card_amount = normalize_amount(amount)
    validate_date(active_date)

    requests_: list[CardRequest] = []
    for index in range(1, count + 1):
        data = {
            "cardType": FIXED_CARD_TYPE,
            "cardAmount": card_amount,
            "cardCurrency": FIXED_CARD_CURRENCY,
            "billCurrency": FIXED_BILL_CURRENCY,
            "useTime": FIXED_USE_TIME,
            "companyRate": FIXED_COMPANY_RATE,
            "activeDate": active_date,
            "extInfoyx": cardholder,
            "supportedMccGroup": FIXED_SUPPORTED_MCC_GROUP,
            "amount": card_amount,
        }
        requests_.append(
            CardRequest(
                index=index,
                payload={
                    "method": CREATE_CARD_METHOD,
                    "timestamp": int(time.time()),
                    "v": API_VERSION,
                    "data": data,
                },
            )
        )
    return requests_


def post_card(app_key: str, token: str, encrypted_param: str, timeout: float = 30.0) -> dict[str, Any]:
    response = requests.post(
        CARD_URL,
        headers={
            "Accept": "application/json",
            "Content-Type": "application/json; charset=utf-8",
            "Authorization": token,
        },
        json={"appKey": app_key, "param": encrypted_param},
        timeout=timeout,
    )
    response.raise_for_status()
    return response.json()


def row_from_response(index: int, payload: dict[str, Any], encrypted_param: str, response: dict[str, Any]) -> dict[str, Any]:
    response = dict(response)
    response["data"] = maybe_json_object(response.get("data"))
    data = response.get("data") if isinstance(response.get("data"), dict) else {}
    code = str(response.get("code", ""))
    success = code in SUCCESS_CODES or bool(data.get("cardNo"))
    row = {
        "index": index,
        "success": "true" if success else "false",
        "code": response.get("code", ""),
        "msg": response.get("msg", ""),
        "requestPayload": json_dumps(payload),
        "encryptedParam": encrypted_param,
        "rawResponse": json_dumps(response),
    }
    for field in OUTPUT_FIELDS:
        row.setdefault(field, data.get(field, ""))
    return row


def error_row(index: int, payload: dict[str, Any], encrypted_param: str, error: Exception) -> dict[str, Any]:
    row = {field: "" for field in OUTPUT_FIELDS}
    row.update(
        {
            "index": index,
            "success": "false",
            "code": "LOCAL_ERROR",
            "msg": str(error),
            "requestPayload": json_dumps(payload),
            "encryptedParam": encrypted_param,
        }
    )
    return row


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8-sig") as file:
        writer = csv.DictWriter(file, fieldnames=OUTPUT_FIELDS)
        writer.writeheader()
        writer.writerows(rows)


def parse_expiry(raw: str) -> tuple[str, str, str]:
    value = str(raw or "").strip()
    if not value:
        return "", "", ""
    for fmt in ("%Y-%m-%d", "%Y/%m/%d"):
        try:
            parsed = datetime.strptime(value, fmt).date()
            return f"{parsed.month:02d}", str(parsed.year), parsed.isoformat()
        except ValueError:
            pass
    digits = "".join(ch for ch in value if ch.isdigit())
    if len(digits) >= 6:
        return digits[4:6], digits[:4], value
    return "", "", value


def safe_row(card_batch_id: str, row: dict[str, Any]) -> dict[str, Any]:
    expiry_month, expiry_year, expires_at = parse_expiry(str(row.get("validityDate", "")))
    card_no = str(row.get("cardNo", ""))
    success = row.get("success") == "true"
    return {
        "card_batch_id": card_batch_id,
        "row_number": row.get("index", ""),
        "card_provider": "EJH",
        "card_product": row.get("cardType", FIXED_CARD_TYPE),
        "open_status": "completed" if success else "failed",
        "error_code": "" if success else row.get("code", ""),
        "error_message": "" if success else row.get("msg", ""),
        "order_no": row.get("orderNo", ""),
        "card_no": card_no,
        "pan_bin6": card_no[:6],
        "pan_last4": card_no[-4:] if len(card_no) >= 4 else "",
        "expiry_month": expiry_month,
        "expiry_year": expiry_year,
        "cvv": row.get("cvvPassword", ""),
        "card_amount": row.get("cardAmount", ""),
        "card_currency": row.get("cardCurrency", ""),
        "bill_amount": row.get("billAmount", ""),
        "bill_currency": row.get("billCurrency", ""),
        "active_date": row.get("startTime", ""),
        "expires_at": expires_at,
        "cardholder_ref": row.get("extInfoyx", ""),
        "ejh_status": row.get("status", ""),
        "is_locked": row.get("isLocked", ""),
        "raw_provider_code": row.get("code", ""),
        "created_at": datetime.now().isoformat(timespec="seconds"),
    }


def write_safe_csv(path: Path, rows: list[dict[str, Any]], card_batch_id: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8-sig") as file:
        writer = csv.DictWriter(file, fieldnames=SAFE_OUTPUT_FIELDS)
        writer.writeheader()
        writer.writerows(safe_row(card_batch_id, row) for row in rows)


def run_batch(
    *,
    app_key: str,
    app_secret: str,
    count: int,
    amount: str,
    active_date: str,
    cardholder: str,
    output_path: Path,
    safe_output: bool = True,
    card_batch_id: str | None = None,
) -> tuple[int, int, Path]:
    card_requests = build_card_requests(count, amount, active_date, cardholder)
    rows: list[dict[str, Any]] = []

    print("正在获取认证 token...")
    token = authenticate(app_key)
    print("认证成功，开始开卡...")

    for card_request in card_requests:
        payload_text = json_dumps(card_request.payload)
        encrypted_param = encrypt_des_ecb_base64(payload_text, app_secret)

        try:
            response = post_card(app_key, token, encrypted_param)
            row = row_from_response(card_request.index, card_request.payload, encrypted_param, response)
            rows.append(row)
            print(
                f"[{card_request.index}/{len(card_requests)}] "
                f"{'成功' if row['success'] == 'true' else '失败'} "
                f"code={row['code']} msg={row['msg']} orderNo={row['orderNo']}"
            )
        except Exception as exc:  # noqa: BLE001 - continue after per-card failures.
            rows.append(error_row(card_request.index, card_request.payload, encrypted_param, exc))
            print(f"[{card_request.index}/{len(card_requests)}] 失败 {exc}", file=sys.stderr)

        if card_request.index < len(card_requests):
            time.sleep(0.5)

    batch_id = card_batch_id or f"ejh-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
    if safe_output:
        write_safe_csv(output_path, rows, batch_id)
    else:
        write_csv(output_path, rows)

    success_count = sum(1 for row in rows if row.get("success") == "true")
    failed_count = len(rows) - success_count
    return success_count, failed_count, output_path


def interactive_main() -> int:
    app_key = prompt_required("请输入KEY：")
    app_secret = prompt_required("请输入secret：", secret=True)
    count = prompt_positive_int("请输入开卡数量：")
    amount = prompt_required("请输入每张卡的开卡金额：")
    active_date = prompt_required("请输入到期时间（yyyy-MM-dd）：")
    cardholder = prompt_required("请输入开卡人：")
    output_path = Path.cwd() / f"ejh_cards_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv"
    success_count, failed_count, output_path = run_batch(
        app_key=app_key,
        app_secret=app_secret,
        count=count,
        amount=amount,
        active_date=active_date,
        cardholder=cardholder,
        output_path=output_path,
    )
    print("开卡完成")
    print(f"成功：{success_count}")
    print(f"失败：{failed_count}")
    print(f"CSV：{output_path}")
    return 0 if failed_count == 0 else 1


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Create EJH cards and emit a safe CSV.")
    parser.add_argument("--non-interactive", action="store_true", help="Read inputs from flags/env instead of prompts.")
    parser.add_argument("--app-key", default=os.environ.get("EJH_APP_KEY", ""))
    parser.add_argument("--app-secret", default=os.environ.get("EJH_APP_SECRET", ""))
    parser.add_argument("--count", type=int)
    parser.add_argument("--amount")
    parser.add_argument("--active-date")
    parser.add_argument("--cardholder")
    parser.add_argument("--card-batch-id")
    parser.add_argument("--output")
    parser.add_argument("--unsafe-raw-output", action="store_true", help="Write legacy raw fields including encrypted payloads.")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    if not args.non_interactive:
        return interactive_main()

    missing = [
        name for name, value in {
            "app-key": args.app_key,
            "app-secret": args.app_secret,
            "count": args.count,
            "amount": args.amount,
            "active-date": args.active_date,
            "cardholder": args.cardholder,
        }.items()
        if not value
    ]
    if missing:
        raise SystemExit(f"缺少非交互参数：{', '.join(missing)}")

    output_path = Path(args.output or Path.cwd() / f"ejh_cards_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv")
    success_count, failed_count, output_path = run_batch(
        app_key=args.app_key,
        app_secret=args.app_secret,
        count=args.count,
        amount=args.amount,
        active_date=args.active_date,
        cardholder=args.cardholder,
        output_path=output_path,
        safe_output=not args.unsafe_raw_output,
        card_batch_id=args.card_batch_id,
    )
    print(json.dumps({
        "ok": failed_count == 0,
        "success": success_count,
        "failed": failed_count,
        "csv": str(output_path),
    }, ensure_ascii=False))
    return 0 if failed_count == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
