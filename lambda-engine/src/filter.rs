//! Constrained metadata filter: parse `sql_filter` to a typed AST, compile to a Lance SQL predicate.
//!
//! User input is never passed to Lance except as validated, compiler-generated fragments.

use crate::error::ApiError;

/// Typed AST for filter expressions (post-parse, pre-execution).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FilterExpr {
    And(Box<FilterExpr>, Box<FilterExpr>),
    Or(Box<FilterExpr>, Box<FilterExpr>),
    Not(Box<FilterExpr>),
    Compare {
        field: FilterField,
        op: CompareOp,
        value: FilterValue,
    },
    In {
        field: FilterField,
        values: Vec<FilterValue>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FilterField {
    IncidentId,
    Timestamp,
    CityCode,
    DocType,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompareOp {
    Eq,
    Ne,
    Lt,
    Lte,
    Gt,
    Gte,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FilterValue {
    String(String),
    /// Validated RFC 3339 timestamp string (as accepted by [`chrono`]).
    Timestamp(String),
}

impl FilterField {
    fn column_name(self) -> &'static str {
        match self {
            FilterField::IncidentId => "incident_id",
            FilterField::Timestamp => "timestamp",
            FilterField::CityCode => "city_code",
            FilterField::DocType => "doc_type",
        }
    }
}

impl CompareOp {
    fn as_sql(self) -> &'static str {
        match self {
            CompareOp::Eq => "=",
            CompareOp::Ne => "!=",
            CompareOp::Lt => "<",
            CompareOp::Lte => "<=",
            CompareOp::Gt => ">",
            CompareOp::Gte => ">=",
        }
    }
}

fn invalid_sql_filter() -> ApiError {
    ApiError::bad_request(
        "INVALID_SQL_FILTER",
        "Unsupported sql_filter syntax. Allowed fields: incident_id, timestamp, city_code, doc_type.",
    )
}

fn invalid_filter_value() -> ApiError {
    ApiError::bad_request(
        "INVALID_FILTER_VALUE",
        "Invalid timestamp literal in sql_filter. Expected RFC 3339.",
    )
}

/// `true` if `input` contains `;` outside of single-quoted string literals.
fn has_bare_semicolon(input: &str) -> bool {
    let mut in_string = false;
    let mut chars = input.chars().peekable();
    while let Some(c) = chars.next() {
        if in_string {
            if c == '\'' {
                match chars.peek() {
                    Some('\'') => {
                        chars.next();
                    }
                    _ => in_string = false,
                }
            }
        } else if c == '\'' {
            in_string = true;
        } else if c == ';' {
            return true;
        }
    }
    false
}

/// Maps a parsed identifier to a filterable column.
///
/// The lexer only allows ASCII letters, digits, and `_` in identifiers. Names are matched
/// ASCII case-insensitively against the four allowed columns (e.g. `city_code` and `CITY_CODE`).
fn map_field(name: &str) -> Result<FilterField, ApiError> {
    if name.eq_ignore_ascii_case("incident_id") {
        return Ok(FilterField::IncidentId);
    }
    if name.eq_ignore_ascii_case("timestamp") {
        return Ok(FilterField::Timestamp);
    }
    if name.eq_ignore_ascii_case("city_code") {
        return Ok(FilterField::CityCode);
    }
    if name.eq_ignore_ascii_case("doc_type") {
        return Ok(FilterField::DocType);
    }
    Err(invalid_sql_filter())
}

fn validate_literal(field: FilterField, raw: String) -> Result<FilterValue, ApiError> {
    match field {
        FilterField::Timestamp => {
            chrono::DateTime::parse_from_rfc3339(&raw).map_err(|_| invalid_filter_value())?;
            Ok(FilterValue::Timestamp(raw))
        }
        _ => Ok(FilterValue::String(raw)),
    }
}

fn escape_sql_string(s: &str) -> String {
    s.replace('\'', "''")
}

/// Scalar SQL fragment for the compiled predicate (DataFusion / Lance `scan().filter`).
///
/// String fields use single-quoted UTF-8 literals. Timestamp values are validated as RFC 3339
/// during parsing; here they are emitted as `CAST('…' AS TIMESTAMP)` so the RHS is a temporal
/// type compatible with Arrow timestamp columns (plain quoted strings would remain Utf8).
fn compile_sql_value(value: &FilterValue) -> String {
    match value {
        FilterValue::String(s) => {
            let inner = escape_sql_string(s);
            format!("'{inner}'")
        }
        FilterValue::Timestamp(s) => {
            let inner = escape_sql_string(s);
            format!("CAST('{inner}' AS TIMESTAMP)")
        }
    }
}

/// Compile a validated AST to a Lance `filter` string (WHERE-clause style).
pub fn compile_filter(expr: &FilterExpr) -> Result<String, ApiError> {
    fn go(e: &FilterExpr) -> String {
        match e {
            FilterExpr::And(a, b) => format!("({}) AND ({})", go(a), go(b)),
            FilterExpr::Or(a, b) => format!("({}) OR ({})", go(a), go(b)),
            FilterExpr::Not(x) => format!("NOT ({})", go(x)),
            FilterExpr::Compare { field, op, value } => {
                format!(
                    "{} {} {}",
                    field.column_name(),
                    op.as_sql(),
                    compile_sql_value(value)
                )
            }
            FilterExpr::In { field, values } => {
                let parts: Vec<String> = values.iter().map(compile_sql_value).collect();
                format!("{} IN ({})", field.column_name(), parts.join(", "))
            }
        }
    }
    Ok(go(expr))
}

struct Parser<'a> {
    rest: &'a str,
}

impl<'a> Parser<'a> {
    fn new(input: &'a str) -> Self {
        Self { rest: input }
    }

    fn skip_ws(&mut self) {
        self.rest = self.rest.trim_start();
    }

    fn is_ident_char(c: char) -> bool {
        matches!(c, 'a'..='z' | 'A'..='Z' | '0'..='9' | '_')
    }

    fn is_ident_start(c: char) -> bool {
        matches!(c, 'a'..='z' | 'A'..='Z' | '_')
    }

    fn consume_keyword_if(&mut self, keyword: &'static str) -> bool {
        self.skip_ws();
        let bytes = self.rest.as_bytes();
        let kw = keyword.as_bytes();
        if bytes.len() < kw.len() {
            return false;
        }
        if !bytes[..kw.len()].eq_ignore_ascii_case(kw) {
            return false;
        }
        if self.rest.len() > kw.len() {
            let next = self.rest[kw.len()..].chars().next().unwrap();
            if Self::is_ident_char(next) {
                return false;
            }
        }
        self.rest = &self.rest[kw.len()..];
        true
    }

    fn parse_ident_str(&mut self) -> Result<&'a str, ApiError> {
        self.skip_ws();
        let mut end = 0usize;
        for (i, c) in self.rest.char_indices() {
            if end == 0 {
                if !Self::is_ident_start(c) {
                    break;
                }
                end = i + c.len_utf8();
            } else if Self::is_ident_char(c) {
                end = i + c.len_utf8();
            } else {
                break;
            }
        }
        if end == 0 {
            return Err(invalid_sql_filter());
        }
        let name = &self.rest[..end];
        self.rest = &self.rest[end..];
        Ok(name)
    }

    fn parse_string_literal(&mut self) -> Result<String, ApiError> {
        self.skip_ws();
        if !self.rest.starts_with('\'') {
            return Err(invalid_sql_filter());
        }
        let mut i = 1usize;
        let mut out = String::new();
        let b = self.rest.as_bytes();
        while i < b.len() {
            if b[i] == b'\'' {
                if i + 1 < b.len() && b[i + 1] == b'\'' {
                    out.push('\'');
                    i += 2;
                } else {
                    i += 1;
                    self.rest = &self.rest[i..];
                    return Ok(out);
                }
            } else {
                let c = self.rest[i..]
                    .chars()
                    .next()
                    .ok_or_else(invalid_sql_filter)?;
                out.push(c);
                i += c.len_utf8();
            }
        }
        Err(invalid_sql_filter())
    }

    fn parse_comp_op(&mut self) -> Result<CompareOp, ApiError> {
        self.skip_ws();
        let rest = self.rest;
        if let Some(stripped) = rest.strip_prefix("!=") {
            self.rest = stripped;
            return Ok(CompareOp::Ne);
        }
        if let Some(stripped) = rest.strip_prefix("<=") {
            self.rest = stripped;
            return Ok(CompareOp::Lte);
        }
        if let Some(stripped) = rest.strip_prefix(">=") {
            self.rest = stripped;
            return Ok(CompareOp::Gte);
        }
        let mut cs = rest.chars();
        let Some(c) = cs.next() else {
            return Err(invalid_sql_filter());
        };
        match c {
            '=' => {
                self.rest = cs.as_str();
                Ok(CompareOp::Eq)
            }
            '<' => {
                self.rest = cs.as_str();
                Ok(CompareOp::Lt)
            }
            '>' => {
                self.rest = cs.as_str();
                Ok(CompareOp::Gt)
            }
            _ => Err(invalid_sql_filter()),
        }
    }

    fn parse_in_list(&mut self, field: FilterField) -> Result<FilterExpr, ApiError> {
        self.skip_ws();
        if !self.rest.starts_with('(') {
            return Err(invalid_sql_filter());
        }
        self.rest = &self.rest[1..];
        let lit = self.parse_string_literal()?;
        let mut values = vec![validate_literal(field, lit)?];
        loop {
            self.skip_ws();
            if self.rest.starts_with(')') {
                self.rest = &self.rest[1..];
                return Ok(FilterExpr::In { field, values });
            }
            if !self.rest.starts_with(',') {
                return Err(invalid_sql_filter());
            }
            self.rest = &self.rest[1..];
            let lit = self.parse_string_literal()?;
            values.push(validate_literal(field, lit)?);
        }
    }

    fn parse_primary(&mut self) -> Result<FilterExpr, ApiError> {
        self.skip_ws();
        if self.rest.starts_with('(') {
            self.rest = &self.rest[1..];
            let e = self.parse_or()?;
            self.skip_ws();
            if !self.rest.starts_with(')') {
                return Err(invalid_sql_filter());
            }
            self.rest = &self.rest[1..];
            return Ok(e);
        }

        let name = self.parse_ident_str()?;
        let field = map_field(name)?;
        self.skip_ws();
        if self.consume_keyword_if("IN") {
            return self.parse_in_list(field);
        }
        let op = self.parse_comp_op()?;
        let lit = self.parse_string_literal()?;
        let value = validate_literal(field, lit)?;
        Ok(FilterExpr::Compare { field, op, value })
    }

    fn parse_unary(&mut self) -> Result<FilterExpr, ApiError> {
        if self.consume_keyword_if("NOT") {
            let inner = self.parse_unary()?;
            return Ok(FilterExpr::Not(Box::new(inner)));
        }
        self.parse_primary()
    }

    fn parse_and(&mut self) -> Result<FilterExpr, ApiError> {
        let mut left = self.parse_unary()?;
        while self.consume_keyword_if("AND") {
            let right = self.parse_unary()?;
            left = FilterExpr::And(Box::new(left), Box::new(right));
        }
        Ok(left)
    }

    fn parse_or(&mut self) -> Result<FilterExpr, ApiError> {
        let mut left = self.parse_and()?;
        while self.consume_keyword_if("OR") {
            let right = self.parse_and()?;
            left = FilterExpr::Or(Box::new(left), Box::new(right));
        }
        Ok(left)
    }
}

/// Parse `sql_filter` into an AST, or `None` if empty / whitespace-only.
pub fn parse_filter(input: &str) -> Result<Option<FilterExpr>, ApiError> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if has_bare_semicolon(trimmed) {
        return Err(invalid_sql_filter());
    }
    let mut p = Parser::new(trimmed);
    let expr = p.parse_or()?;
    p.skip_ws();
    if !p.rest.is_empty() {
        return Err(invalid_sql_filter());
    }
    Ok(Some(expr))
}

/// Parse and compile in one step (for the search path).
pub fn parse_and_compile(input: &str) -> Result<Option<String>, ApiError> {
    match parse_filter(input)? {
        None => Ok(None),
        Some(expr) => Ok(Some(compile_filter(&expr)?)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_and_whitespace_yield_none() {
        assert_eq!(parse_filter("").unwrap(), None);
        assert_eq!(parse_filter("   \n\t").unwrap(), None);
    }

    #[test]
    fn simple_equality_compiles() {
        let e = parse_filter("city_code = 'NYC-TLC'").unwrap().unwrap();
        assert_eq!(compile_filter(&e).unwrap(), "city_code = 'NYC-TLC'");
    }

    #[test]
    fn in_list_compiles() {
        let e = parse_filter("doc_type IN ('Insurance_Lapse_Report', 'Safety_Incident_Log')")
            .unwrap()
            .unwrap();
        assert_eq!(
            compile_filter(&e).unwrap(),
            "doc_type IN ('Insurance_Lapse_Report', 'Safety_Incident_Log')"
        );
    }

    #[test]
    fn and_groups_with_parens_in_output() {
        let e = parse_filter("city_code = 'NYC-TLC' AND doc_type = 'Insurance_Lapse_Report'")
            .unwrap()
            .unwrap();
        assert_eq!(
            compile_filter(&e).unwrap(),
            "(city_code = 'NYC-TLC') AND (doc_type = 'Insurance_Lapse_Report')"
        );
    }

    #[test]
    fn timestamp_range_compiles() {
        let e = parse_filter(
            "timestamp >= '2025-01-01T00:00:00Z' AND timestamp < '2026-01-01T00:00:00Z'",
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            compile_filter(&e).unwrap(),
            "(timestamp >= CAST('2025-01-01T00:00:00Z' AS TIMESTAMP)) AND (timestamp < CAST('2026-01-01T00:00:00Z' AS TIMESTAMP))"
        );
    }

    #[test]
    fn timestamp_compare_single_casts() {
        let e = parse_filter("timestamp = '2025-06-15T12:00:00+00:00'")
            .unwrap()
            .unwrap();
        assert_eq!(
            compile_filter(&e).unwrap(),
            "timestamp = CAST('2025-06-15T12:00:00+00:00' AS TIMESTAMP)"
        );
    }

    #[test]
    fn timestamp_in_list_each_casts() {
        let e = parse_filter("timestamp IN ('2025-01-01T00:00:00Z', '2025-06-01T00:00:00Z')")
            .unwrap()
            .unwrap();
        assert_eq!(
            compile_filter(&e).unwrap(),
            "timestamp IN (CAST('2025-01-01T00:00:00Z' AS TIMESTAMP), CAST('2025-06-01T00:00:00Z' AS TIMESTAMP))"
        );
    }

    #[test]
    fn field_identifier_ascii_case_insensitive() {
        let e = parse_filter("CITY_CODE = 'NYC-TLC'").unwrap().unwrap();
        assert_eq!(compile_filter(&e).unwrap(), "city_code = 'NYC-TLC'");
    }

    #[test]
    fn unicode_string_literal_compiles_utf8() {
        let e = parse_filter("city_code = '東京-TLC'").unwrap().unwrap();
        assert_eq!(compile_filter(&e).unwrap(), "city_code = '東京-TLC'");
    }

    #[test]
    fn nested_or_and() {
        let e = parse_filter(
            "(city_code = 'NYC-TLC' OR city_code = 'SF-CPUC') AND doc_type != 'Data_Privacy_Request'",
        )
        .unwrap()
        .unwrap();
        let s = compile_filter(&e).unwrap();
        assert!(s.contains("OR"));
        assert!(s.contains("AND"));
        assert!(s.contains("doc_type"));
    }

    #[test]
    fn not_supported() {
        let e = parse_filter("NOT city_code = 'X'").unwrap().unwrap();
        assert_eq!(compile_filter(&e).unwrap(), "NOT (city_code = 'X')");
    }

    #[test]
    fn string_escape_in_output() {
        let e = parse_filter("city_code = 'O''Reilly'").unwrap().unwrap();
        assert_eq!(compile_filter(&e).unwrap(), "city_code = 'O''Reilly'");
    }

    #[test]
    fn bad_timestamp_literal() {
        let err = parse_filter("timestamp = 'not-a-date'").unwrap_err();
        assert_eq!(err.code, "INVALID_FILTER_VALUE");
    }

    #[test]
    fn unknown_field() {
        let err = parse_filter("text_content = 'x'").unwrap_err();
        assert_eq!(err.code, "INVALID_SQL_FILTER");
    }

    #[test]
    fn lower_function_rejected() {
        let err = parse_filter("LOWER(city_code) = 'nyc-tlc'").unwrap_err();
        assert_eq!(err.code, "INVALID_SQL_FILTER");
    }

    #[test]
    fn like_rejected() {
        let err = parse_filter("city_code LIKE '%x%'").unwrap_err();
        assert_eq!(err.code, "INVALID_SQL_FILTER");
    }

    #[test]
    fn select_rejected() {
        let err = parse_filter("SELECT * FROM x").unwrap_err();
        assert_eq!(err.code, "INVALID_SQL_FILTER");
    }

    #[test]
    fn semicolon_rejected() {
        let err = parse_filter("city_code = 'NYC-TLC'; DROP TABLE foo;").unwrap_err();
        assert_eq!(err.code, "INVALID_SQL_FILTER");
    }

    #[test]
    fn trailing_garbage_rejected() {
        let err = parse_filter("city_code = 'X' foo").unwrap_err();
        assert_eq!(err.code, "INVALID_SQL_FILTER");
    }

    #[test]
    fn empty_in_list_rejected() {
        let err = parse_filter("city_code IN ()").unwrap_err();
        assert_eq!(err.code, "INVALID_SQL_FILTER");
    }

    #[test]
    fn parse_and_compile_none() {
        assert_eq!(parse_and_compile("  ").unwrap(), None);
    }

    #[test]
    fn parse_and_compile_some() {
        let s = parse_and_compile("incident_id = 'abc'").unwrap().unwrap();
        assert_eq!(s, "incident_id = 'abc'");
    }

    /// Exercises the same `Dataset::scan().filter(&str)` path as production against a tiny
    /// on-disk Lance table (DataFusion must accept the compiled predicate).
    #[tokio::test]
    async fn lance_scan_accepts_compiled_timestamp_predicate() {
        use std::sync::Arc;

        use arrow_array::{RecordBatch, RecordBatchIterator, TimestampMillisecondArray};
        use arrow_schema::{DataType, Field, Schema, TimeUnit};
        use futures::TryStreamExt;
        use lance::dataset::WriteParams;
        use lance::Dataset;

        let dir = std::env::temp_dir().join(format!(
            "trace_lambda_filter_lance_{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        if dir.exists() {
            let _ = std::fs::remove_dir_all(&dir);
        }
        std::fs::create_dir_all(&dir).unwrap();
        let uri = dir.to_str().unwrap().to_string();

        let ts_ms = chrono::DateTime::parse_from_rfc3339("2025-06-01T00:00:00Z")
            .unwrap()
            .timestamp_millis();
        let schema = Arc::new(Schema::new(vec![Field::new(
            "timestamp",
            DataType::Timestamp(TimeUnit::Millisecond, None),
            false,
        )]));
        let batch = RecordBatch::try_new(
            schema.clone(),
            vec![Arc::new(TimestampMillisecondArray::from(vec![ts_ms]))],
        )
        .unwrap();
        let reader = RecordBatchIterator::new(vec![Ok(batch)], schema.clone());
        Dataset::write(reader, &uri, Some(WriteParams::default()))
            .await
            .unwrap();

        let pred = parse_and_compile("timestamp >= '2025-01-01T00:00:00Z'")
            .unwrap()
            .unwrap();
        let ds = Dataset::open(&uri).await.unwrap();
        let mut scan = ds.scan();
        scan.filter(&pred)
            .expect("compiled filter should be accepted by Lance scanner");
        let stream = scan.try_into_stream().await.unwrap();
        let total_rows: usize = stream
            .try_fold(0usize, |acc, b| async move { Ok(acc + b.num_rows()) })
            .await
            .unwrap();
        assert_eq!(total_rows, 1);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
