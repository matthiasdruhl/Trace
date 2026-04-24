"""
Shared constrained sql_filter parsing, compilation, and local evaluation helpers.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, TypeAlias


MAX_SQL_FILTER_CHARS = 8192
ALLOWED_FILTER_FIELDS = frozenset({"incident_id", "timestamp", "city_code", "doc_type"})


class FilterSyntaxError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class FilterCompare:
    field: str
    op: str
    value: tuple[str, str]


@dataclass(frozen=True)
class FilterIn:
    field: str
    values: tuple[tuple[str, str], ...]


FilterExpr: TypeAlias = FilterCompare | FilterIn | tuple[str, Any]  # recursive sum type


def _invalid_sql_filter() -> FilterSyntaxError:
    return FilterSyntaxError(
        "INVALID_SQL_FILTER",
        "Unsupported sql_filter syntax. Allowed fields: incident_id, timestamp, city_code, doc_type.",
    )


def _invalid_filter_value() -> FilterSyntaxError:
    return FilterSyntaxError(
        "INVALID_FILTER_VALUE",
        "Invalid timestamp literal in sql_filter. Expected RFC 3339.",
    )


def _has_bare_semicolon(raw: str) -> bool:
    in_string = False
    i = 0
    while i < len(raw):
        char = raw[i]
        if in_string:
            if char == "'":
                if i + 1 < len(raw) and raw[i + 1] == "'":
                    i += 2
                    continue
                in_string = False
        elif char == "'":
            in_string = True
        elif char == ";":
            return True
        i += 1
    return False


def _validate_timestamp_literal(raw: str) -> None:
    if not re.fullmatch(
        r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})", raw
    ):
        raise _invalid_filter_value()
    try:
        datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError as exc:
        raise _invalid_filter_value() from exc


def _validate_filter_literal(field: str, raw: str) -> tuple[str, str]:
    if field == "timestamp":
        _validate_timestamp_literal(raw)
        return ("timestamp", raw)
    return ("string", raw)


def _escape_sql_string(value: str) -> str:
    return value.replace("'", "''")


def _compile_filter_value(value: tuple[str, str]) -> str:
    value_type, raw = value
    escaped = _escape_sql_string(raw)
    if value_type == "timestamp":
        return f"CAST('{escaped}' AS TIMESTAMP)"
    return f"'{escaped}'"


def compile_filter(expr: FilterExpr) -> str:
    if isinstance(expr, FilterCompare):
        return f"{expr.field} {expr.op} {_compile_filter_value(expr.value)}"
    if isinstance(expr, FilterIn):
        values = ", ".join(_compile_filter_value(value) for value in expr.values)
        return f"{expr.field} IN ({values})"
    if expr[0] == "and":
        return f"({compile_filter(expr[1])}) AND ({compile_filter(expr[2])})"
    if expr[0] == "or":
        return f"({compile_filter(expr[1])}) OR ({compile_filter(expr[2])})"
    if expr[0] == "not":
        return f"NOT ({compile_filter(expr[1])})"
    raise AssertionError(f"Unsupported filter expression: {expr!r}")


class FilterParser:
    def __init__(self, raw: str) -> None:
        self.rest = raw

    def skip_ws(self) -> None:
        self.rest = self.rest.lstrip()

    @staticmethod
    def _is_ident_char(char: str) -> bool:
        return char.isascii() and (char.isalnum() or char == "_")

    @staticmethod
    def _is_ident_start(char: str) -> bool:
        return char.isascii() and (char.isalpha() or char == "_")

    def consume_keyword_if(self, keyword: str) -> bool:
        self.skip_ws()
        candidate = self.rest[: len(keyword)]
        if candidate.lower() != keyword.lower():
            return False
        if len(self.rest) > len(keyword):
            next_char = self.rest[len(keyword)]
            if self._is_ident_char(next_char):
                return False
        self.rest = self.rest[len(keyword) :]
        return True

    def parse_identifier(self) -> str:
        self.skip_ws()
        if not self.rest or not self._is_ident_start(self.rest[0]):
            raise _invalid_sql_filter()
        end = 1
        while end < len(self.rest) and self._is_ident_char(self.rest[end]):
            end += 1
        ident = self.rest[:end]
        self.rest = self.rest[end:]
        mapped = ident.lower()
        if mapped not in ALLOWED_FILTER_FIELDS:
            raise _invalid_sql_filter()
        return mapped

    def parse_string_literal(self) -> str:
        self.skip_ws()
        if not self.rest.startswith("'"):
            raise _invalid_sql_filter()
        i = 1
        chars: list[str] = []
        while i < len(self.rest):
            current = self.rest[i]
            if current == "'":
                if i + 1 < len(self.rest) and self.rest[i + 1] == "'":
                    chars.append("'")
                    i += 2
                    continue
                self.rest = self.rest[i + 1 :]
                return "".join(chars)
            chars.append(current)
            i += 1
        raise _invalid_sql_filter()

    def parse_compare_op(self) -> str:
        self.skip_ws()
        for op in ("!=", "<=", ">=", "=", "<", ">"):
            if self.rest.startswith(op):
                self.rest = self.rest[len(op) :]
                return op
        raise _invalid_sql_filter()

    def parse_in_list(self, field: str) -> FilterIn:
        self.skip_ws()
        if not self.rest.startswith("("):
            raise _invalid_sql_filter()
        self.rest = self.rest[1:]
        values: list[tuple[str, str]] = []
        while True:
            raw = self.parse_string_literal()
            values.append(_validate_filter_literal(field, raw))
            self.skip_ws()
            if self.rest.startswith(","):
                self.rest = self.rest[1:]
                continue
            if self.rest.startswith(")"):
                self.rest = self.rest[1:]
                break
            raise _invalid_sql_filter()
        if not values:
            raise _invalid_sql_filter()
        return FilterIn(field=field, values=tuple(values))

    def parse_primary(self) -> FilterExpr:
        self.skip_ws()
        if self.rest.startswith("("):
            self.rest = self.rest[1:]
            expr = self.parse_or()
            self.skip_ws()
            if not self.rest.startswith(")"):
                raise _invalid_sql_filter()
            self.rest = self.rest[1:]
            return expr

        field = self.parse_identifier()
        if self.consume_keyword_if("IN"):
            return self.parse_in_list(field)
        op = self.parse_compare_op()
        raw = self.parse_string_literal()
        return FilterCompare(field=field, op=op, value=_validate_filter_literal(field, raw))

    def parse_unary(self) -> FilterExpr:
        if self.consume_keyword_if("NOT"):
            return ("not", self.parse_unary())
        return self.parse_primary()

    def parse_and(self) -> FilterExpr:
        expr = self.parse_unary()
        while self.consume_keyword_if("AND"):
            expr = ("and", expr, self.parse_unary())
        return expr

    def parse_or(self) -> FilterExpr:
        expr = self.parse_and()
        while self.consume_keyword_if("OR"):
            expr = ("or", expr, self.parse_and())
        return expr


def parse_sql_filter(raw: str | None) -> FilterExpr | None:
    if raw is None:
        return None
    sql_filter = raw.strip()
    if not sql_filter:
        return None
    n_chars = len(sql_filter)
    if n_chars > MAX_SQL_FILTER_CHARS:
        raise FilterSyntaxError(
            "SQL_FILTER_TOO_LONG",
            f"sql_filter must be at most {MAX_SQL_FILTER_CHARS} characters (got {n_chars})",
        )
    if _has_bare_semicolon(sql_filter):
        raise _invalid_sql_filter()
    parser = FilterParser(sql_filter)
    expr = parser.parse_or()
    parser.skip_ws()
    if parser.rest:
        raise _invalid_sql_filter()
    return expr


def parse_and_compile_sql_filter(raw: str | None) -> str | None:
    expr = parse_sql_filter(raw)
    if expr is None:
        return None
    return compile_filter(expr)


def _normalize_timestamp(value: Any) -> datetime:
    if isinstance(value, datetime):
        if value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)
    if hasattr(value, "to_pydatetime"):
        raw_dt = value.to_pydatetime()
        if raw_dt.tzinfo is None:
            return raw_dt.replace(tzinfo=timezone.utc)
        return raw_dt.astimezone(timezone.utc)
    if isinstance(value, str):
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            return parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    raise ValueError(f"Unsupported timestamp value: {value!r}")


def _coerce_value_for_eval(value: tuple[str, str] | Any) -> Any:
    if isinstance(value, tuple) and len(value) == 2:
        value_type, raw = value
        if value_type == "timestamp":
            return _normalize_timestamp(raw)
        return raw
    return value


def _compare_values(actual: Any, op: str, expected: Any) -> bool:
    if op == "=":
        return actual == expected
    if op == "!=":
        return actual != expected
    if op == "<":
        return actual < expected
    if op == "<=":
        return actual <= expected
    if op == ">":
        return actual > expected
    if op == ">=":
        return actual >= expected
    raise AssertionError(f"Unsupported compare op: {op}")


def evaluate_filter(expr: FilterExpr | None, row: dict[str, Any]) -> bool:
    if expr is None:
        return True
    if isinstance(expr, FilterCompare):
        actual = row.get(expr.field)
        expected = _coerce_value_for_eval(expr.value)
        if expr.field == "timestamp":
            actual = _normalize_timestamp(actual)
        elif actual is not None:
            actual = str(actual)
        return _compare_values(actual, expr.op, expected)
    if isinstance(expr, FilterIn):
        actual = row.get(expr.field)
        if expr.field == "timestamp":
            actual = _normalize_timestamp(actual)
        elif actual is not None:
            actual = str(actual)
        expected_values = {_coerce_value_for_eval(value) for value in expr.values}
        return actual in expected_values
    if expr[0] == "and":
        return evaluate_filter(expr[1], row) and evaluate_filter(expr[2], row)
    if expr[0] == "or":
        return evaluate_filter(expr[1], row) or evaluate_filter(expr[2], row)
    if expr[0] == "not":
        return not evaluate_filter(expr[1], row)
    raise AssertionError(f"Unsupported filter expression: {expr!r}")
