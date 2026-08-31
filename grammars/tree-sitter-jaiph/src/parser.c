#include "tree_sitter/parser.h"

#if defined(__GNUC__) || defined(__clang__)
#pragma GCC diagnostic ignored "-Wmissing-field-initializers"
#endif

#define LANGUAGE_VERSION 14
#define STATE_COUNT 14
#define LARGE_STATE_COUNT 9
#define SYMBOL_COUNT 68
#define ALIAS_COUNT 0
#define TOKEN_COUNT 63
#define EXTERNAL_TOKEN_COUNT 0
#define FIELD_COUNT 2
#define MAX_ALIAS_SEQUENCE_LENGTH 4
#define PRODUCTION_ID_COUNT 4

enum ts_symbol_identifiers {
  sym_identifier = 1,
  anon_sym_import = 2,
  anon_sym_export = 3,
  anon_sym_as = 4,
  anon_sym_config = 5,
  anon_sym_channel = 6,
  anon_sym_script = 7,
  anon_sym_def = 8,
  anon_sym_test = 9,
  anon_sym_use = 10,
  anon_sym_const = 11,
  anon_sym_run = 12,
  anon_sym_prompt = 13,
  anon_sym_log = 14,
  anon_sym_logerr = 15,
  anon_sym_logwarn = 16,
  anon_sym_fail = 17,
  anon_sym_return = 18,
  anon_sym_send = 19,
  anon_sym_recover = 20,
  anon_sym_catch = 21,
  anon_sym_if = 22,
  anon_sym_else = 23,
  anon_sym_for = 24,
  anon_sym_in = 25,
  anon_sym_match = 26,
  anon_sym_async = 27,
  anon_sym_returns = 28,
  anon_sym_not = 29,
  anon_sym_mock = 30,
  anon_sym_allow_failure = 31,
  anon_sym_expect_contain = 32,
  anon_sym_expect_not_contain = 33,
  anon_sym_expect_equal = 34,
  anon_sym_true = 35,
  anon_sym_false = 36,
  anon_sym_LBRACE = 37,
  anon_sym_RBRACE = 38,
  anon_sym_LPAREN = 39,
  anon_sym_RPAREN = 40,
  anon_sym_LBRACK = 41,
  anon_sym_RBRACK = 42,
  anon_sym_DOT = 43,
  anon_sym_COMMA = 44,
  sym_comment = 45,
  anon_sym_LT_DASH = 46,
  anon_sym_DASH_GT = 47,
  anon_sym_EQ_GT = 48,
  anon_sym_EQ_EQ = 49,
  anon_sym_BANG_EQ = 50,
  anon_sym_EQ_TILDE = 51,
  anon_sym_BANG_TILDE = 52,
  anon_sym_EQ = 53,
  sym_number = 54,
  sym_qualified_identifier = 55,
  sym_regex = 56,
  sym_string = 57,
  sym_triple_string = 58,
  sym_backtick_string = 59,
  anon_sym_BQUOTE_BQUOTE_BQUOTE = 60,
  sym_fence_language = 61,
  sym_fence_content = 62,
  sym_source_file = 63,
  sym__token = 64,
  sym_operator = 65,
  sym_fenced_block = 66,
  aux_sym_source_file_repeat1 = 67,
};

static const char * const ts_symbol_names[] = {
  [ts_builtin_sym_end] = "end",
  [sym_identifier] = "identifier",
  [anon_sym_import] = "import",
  [anon_sym_export] = "export",
  [anon_sym_as] = "as",
  [anon_sym_config] = "config",
  [anon_sym_channel] = "channel",
  [anon_sym_script] = "script",
  [anon_sym_def] = "def",
  [anon_sym_test] = "test",
  [anon_sym_use] = "use",
  [anon_sym_const] = "const",
  [anon_sym_run] = "run",
  [anon_sym_prompt] = "prompt",
  [anon_sym_log] = "log",
  [anon_sym_logerr] = "logerr",
  [anon_sym_logwarn] = "logwarn",
  [anon_sym_fail] = "fail",
  [anon_sym_return] = "return",
  [anon_sym_send] = "send",
  [anon_sym_recover] = "recover",
  [anon_sym_catch] = "catch",
  [anon_sym_if] = "if",
  [anon_sym_else] = "else",
  [anon_sym_for] = "for",
  [anon_sym_in] = "in",
  [anon_sym_match] = "match",
  [anon_sym_async] = "async",
  [anon_sym_returns] = "returns",
  [anon_sym_not] = "not",
  [anon_sym_mock] = "mock",
  [anon_sym_allow_failure] = "allow_failure",
  [anon_sym_expect_contain] = "expect_contain",
  [anon_sym_expect_not_contain] = "expect_not_contain",
  [anon_sym_expect_equal] = "expect_equal",
  [anon_sym_true] = "true",
  [anon_sym_false] = "false",
  [anon_sym_LBRACE] = "{",
  [anon_sym_RBRACE] = "}",
  [anon_sym_LPAREN] = "(",
  [anon_sym_RPAREN] = ")",
  [anon_sym_LBRACK] = "[",
  [anon_sym_RBRACK] = "]",
  [anon_sym_DOT] = ".",
  [anon_sym_COMMA] = ",",
  [sym_comment] = "comment",
  [anon_sym_LT_DASH] = "<-",
  [anon_sym_DASH_GT] = "->",
  [anon_sym_EQ_GT] = "=>",
  [anon_sym_EQ_EQ] = "==",
  [anon_sym_BANG_EQ] = "!=",
  [anon_sym_EQ_TILDE] = "=~",
  [anon_sym_BANG_TILDE] = "!~",
  [anon_sym_EQ] = "=",
  [sym_number] = "number",
  [sym_qualified_identifier] = "qualified_identifier",
  [sym_regex] = "regex",
  [sym_string] = "string",
  [sym_triple_string] = "triple_string",
  [sym_backtick_string] = "backtick_string",
  [anon_sym_BQUOTE_BQUOTE_BQUOTE] = "```",
  [sym_fence_language] = "language",
  [sym_fence_content] = "embedded",
  [sym_source_file] = "source_file",
  [sym__token] = "_token",
  [sym_operator] = "operator",
  [sym_fenced_block] = "fenced_block",
  [aux_sym_source_file_repeat1] = "source_file_repeat1",
};

static const TSSymbol ts_symbol_map[] = {
  [ts_builtin_sym_end] = ts_builtin_sym_end,
  [sym_identifier] = sym_identifier,
  [anon_sym_import] = anon_sym_import,
  [anon_sym_export] = anon_sym_export,
  [anon_sym_as] = anon_sym_as,
  [anon_sym_config] = anon_sym_config,
  [anon_sym_channel] = anon_sym_channel,
  [anon_sym_script] = anon_sym_script,
  [anon_sym_def] = anon_sym_def,
  [anon_sym_test] = anon_sym_test,
  [anon_sym_use] = anon_sym_use,
  [anon_sym_const] = anon_sym_const,
  [anon_sym_run] = anon_sym_run,
  [anon_sym_prompt] = anon_sym_prompt,
  [anon_sym_log] = anon_sym_log,
  [anon_sym_logerr] = anon_sym_logerr,
  [anon_sym_logwarn] = anon_sym_logwarn,
  [anon_sym_fail] = anon_sym_fail,
  [anon_sym_return] = anon_sym_return,
  [anon_sym_send] = anon_sym_send,
  [anon_sym_recover] = anon_sym_recover,
  [anon_sym_catch] = anon_sym_catch,
  [anon_sym_if] = anon_sym_if,
  [anon_sym_else] = anon_sym_else,
  [anon_sym_for] = anon_sym_for,
  [anon_sym_in] = anon_sym_in,
  [anon_sym_match] = anon_sym_match,
  [anon_sym_async] = anon_sym_async,
  [anon_sym_returns] = anon_sym_returns,
  [anon_sym_not] = anon_sym_not,
  [anon_sym_mock] = anon_sym_mock,
  [anon_sym_allow_failure] = anon_sym_allow_failure,
  [anon_sym_expect_contain] = anon_sym_expect_contain,
  [anon_sym_expect_not_contain] = anon_sym_expect_not_contain,
  [anon_sym_expect_equal] = anon_sym_expect_equal,
  [anon_sym_true] = anon_sym_true,
  [anon_sym_false] = anon_sym_false,
  [anon_sym_LBRACE] = anon_sym_LBRACE,
  [anon_sym_RBRACE] = anon_sym_RBRACE,
  [anon_sym_LPAREN] = anon_sym_LPAREN,
  [anon_sym_RPAREN] = anon_sym_RPAREN,
  [anon_sym_LBRACK] = anon_sym_LBRACK,
  [anon_sym_RBRACK] = anon_sym_RBRACK,
  [anon_sym_DOT] = anon_sym_DOT,
  [anon_sym_COMMA] = anon_sym_COMMA,
  [sym_comment] = sym_comment,
  [anon_sym_LT_DASH] = anon_sym_LT_DASH,
  [anon_sym_DASH_GT] = anon_sym_DASH_GT,
  [anon_sym_EQ_GT] = anon_sym_EQ_GT,
  [anon_sym_EQ_EQ] = anon_sym_EQ_EQ,
  [anon_sym_BANG_EQ] = anon_sym_BANG_EQ,
  [anon_sym_EQ_TILDE] = anon_sym_EQ_TILDE,
  [anon_sym_BANG_TILDE] = anon_sym_BANG_TILDE,
  [anon_sym_EQ] = anon_sym_EQ,
  [sym_number] = sym_number,
  [sym_qualified_identifier] = sym_qualified_identifier,
  [sym_regex] = sym_regex,
  [sym_string] = sym_string,
  [sym_triple_string] = sym_triple_string,
  [sym_backtick_string] = sym_backtick_string,
  [anon_sym_BQUOTE_BQUOTE_BQUOTE] = anon_sym_BQUOTE_BQUOTE_BQUOTE,
  [sym_fence_language] = sym_fence_language,
  [sym_fence_content] = sym_fence_content,
  [sym_source_file] = sym_source_file,
  [sym__token] = sym__token,
  [sym_operator] = sym_operator,
  [sym_fenced_block] = sym_fenced_block,
  [aux_sym_source_file_repeat1] = aux_sym_source_file_repeat1,
};

static const TSSymbolMetadata ts_symbol_metadata[] = {
  [ts_builtin_sym_end] = {
    .visible = false,
    .named = true,
  },
  [sym_identifier] = {
    .visible = true,
    .named = true,
  },
  [anon_sym_import] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_export] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_as] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_config] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_channel] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_script] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_def] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_test] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_use] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_const] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_run] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_prompt] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_log] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_logerr] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_logwarn] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_fail] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_return] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_send] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_recover] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_catch] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_if] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_else] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_for] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_in] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_match] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_async] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_returns] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_not] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_mock] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_allow_failure] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_expect_contain] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_expect_not_contain] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_expect_equal] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_true] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_false] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_LBRACE] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_RBRACE] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_LPAREN] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_RPAREN] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_LBRACK] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_RBRACK] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_DOT] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_COMMA] = {
    .visible = true,
    .named = false,
  },
  [sym_comment] = {
    .visible = true,
    .named = true,
  },
  [anon_sym_LT_DASH] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_DASH_GT] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_EQ_GT] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_EQ_EQ] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_BANG_EQ] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_EQ_TILDE] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_BANG_TILDE] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_EQ] = {
    .visible = true,
    .named = false,
  },
  [sym_number] = {
    .visible = true,
    .named = true,
  },
  [sym_qualified_identifier] = {
    .visible = true,
    .named = true,
  },
  [sym_regex] = {
    .visible = true,
    .named = true,
  },
  [sym_string] = {
    .visible = true,
    .named = true,
  },
  [sym_triple_string] = {
    .visible = true,
    .named = true,
  },
  [sym_backtick_string] = {
    .visible = true,
    .named = true,
  },
  [anon_sym_BQUOTE_BQUOTE_BQUOTE] = {
    .visible = true,
    .named = false,
  },
  [sym_fence_language] = {
    .visible = true,
    .named = true,
  },
  [sym_fence_content] = {
    .visible = true,
    .named = true,
  },
  [sym_source_file] = {
    .visible = true,
    .named = true,
  },
  [sym__token] = {
    .visible = false,
    .named = true,
  },
  [sym_operator] = {
    .visible = true,
    .named = true,
  },
  [sym_fenced_block] = {
    .visible = true,
    .named = true,
  },
  [aux_sym_source_file_repeat1] = {
    .visible = false,
    .named = false,
  },
};

enum ts_field_identifiers {
  field_body = 1,
  field_language = 2,
};

static const char * const ts_field_names[] = {
  [0] = NULL,
  [field_body] = "body",
  [field_language] = "language",
};

static const TSFieldMapSlice ts_field_map_slices[PRODUCTION_ID_COUNT] = {
  [1] = {.index = 0, .length = 1},
  [2] = {.index = 1, .length = 1},
  [3] = {.index = 2, .length = 2},
};

static const TSFieldMapEntry ts_field_map_entries[] = {
  [0] =
    {field_language, 1},
  [1] =
    {field_body, 1},
  [2] =
    {field_body, 2},
    {field_language, 1},
};

static const TSSymbol ts_alias_sequences[PRODUCTION_ID_COUNT][MAX_ALIAS_SEQUENCE_LENGTH] = {
  [0] = {0},
};

static const uint16_t ts_non_terminal_alias_map[] = {
  0,
};

static const TSStateId ts_primary_state_ids[STATE_COUNT] = {
  [0] = 0,
  [1] = 1,
  [2] = 2,
  [3] = 3,
  [4] = 4,
  [5] = 5,
  [6] = 6,
  [7] = 7,
  [8] = 8,
  [9] = 9,
  [10] = 10,
  [11] = 11,
  [12] = 12,
  [13] = 13,
};

static bool ts_lex(TSLexer *lexer, TSStateId state) {
  START_LEXER();
  eof = lexer->eof(lexer);
  switch (state) {
    case 0:
      if (eof) ADVANCE(21);
      ADVANCE_MAP(
        '!', 8,
        '"', 1,
        '#', 30,
        '(', 24,
        ')', 25,
        ',', 29,
        '-', 9,
        '.', 28,
        '/', 18,
        '<', 6,
        '=', 38,
        '[', 26,
        ']', 27,
        '`', 10,
        '{', 22,
        '}', 23,
      );
      if (('\t' <= lookahead && lookahead <= '\r') ||
          lookahead == ' ') SKIP(0);
      if (('0' <= lookahead && lookahead <= '9')) ADVANCE(39);
      if (('A' <= lookahead && lookahead <= 'Z') ||
          ('_' <= lookahead && lookahead <= 'z')) ADVANCE(40);
      END_STATE();
    case 1:
      if (lookahead == '"') ADVANCE(44);
      if (lookahead == '\\') ADVANCE(19);
      if (lookahead != 0) ADVANCE(2);
      END_STATE();
    case 2:
      if (lookahead == '"') ADVANCE(43);
      if (lookahead == '\\') ADVANCE(19);
      if (lookahead != 0) ADVANCE(2);
      END_STATE();
    case 3:
      if (lookahead == '"') ADVANCE(45);
      if (lookahead != 0) ADVANCE(5);
      END_STATE();
    case 4:
      if (lookahead == '"') ADVANCE(3);
      if (lookahead != 0) ADVANCE(5);
      END_STATE();
    case 5:
      if (lookahead == '"') ADVANCE(4);
      if (lookahead != 0) ADVANCE(5);
      END_STATE();
    case 6:
      if (lookahead == '-') ADVANCE(31);
      END_STATE();
    case 7:
      if (lookahead == '/') ADVANCE(42);
      if (lookahead != 0 &&
          lookahead != '\n') ADVANCE(7);
      END_STATE();
    case 8:
      if (lookahead == '=') ADVANCE(35);
      if (lookahead == '~') ADVANCE(37);
      END_STATE();
    case 9:
      if (lookahead == '>') ADVANCE(32);
      END_STATE();
    case 10:
      if (lookahead == '`') ADVANCE(47);
      if (lookahead != 0) ADVANCE(12);
      END_STATE();
    case 11:
      if (lookahead == '`') ADVANCE(48);
      if (lookahead != 0) ADVANCE(51);
      END_STATE();
    case 12:
      if (lookahead == '`') ADVANCE(46);
      if (lookahead != 0) ADVANCE(12);
      END_STATE();
    case 13:
      if (lookahead == '`') ADVANCE(20);
      if (lookahead != 0) ADVANCE(51);
      END_STATE();
    case 14:
      if (lookahead == '`') ADVANCE(16);
      if (('\t' <= lookahead && lookahead <= '\r') ||
          lookahead == ' ') ADVANCE(50);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          ('_' <= lookahead && lookahead <= 'z')) ADVANCE(49);
      if (lookahead != 0) ADVANCE(51);
      END_STATE();
    case 15:
      if (lookahead == '`') ADVANCE(16);
      if (('\t' <= lookahead && lookahead <= '\r') ||
          lookahead == ' ') ADVANCE(50);
      if (lookahead != 0) ADVANCE(51);
      END_STATE();
    case 16:
      if (lookahead == '`') ADVANCE(11);
      if (lookahead != 0) ADVANCE(51);
      END_STATE();
    case 17:
      if (('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(41);
      END_STATE();
    case 18:
      if (lookahead != 0 &&
          lookahead != '\n' &&
          lookahead != '/') ADVANCE(7);
      END_STATE();
    case 19:
      if (lookahead != 0 &&
          lookahead != '\n') ADVANCE(2);
      END_STATE();
    case 20:
      if (lookahead != 0 &&
          lookahead != '`') ADVANCE(51);
      END_STATE();
    case 21:
      ACCEPT_TOKEN(ts_builtin_sym_end);
      END_STATE();
    case 22:
      ACCEPT_TOKEN(anon_sym_LBRACE);
      END_STATE();
    case 23:
      ACCEPT_TOKEN(anon_sym_RBRACE);
      END_STATE();
    case 24:
      ACCEPT_TOKEN(anon_sym_LPAREN);
      END_STATE();
    case 25:
      ACCEPT_TOKEN(anon_sym_RPAREN);
      END_STATE();
    case 26:
      ACCEPT_TOKEN(anon_sym_LBRACK);
      END_STATE();
    case 27:
      ACCEPT_TOKEN(anon_sym_RBRACK);
      END_STATE();
    case 28:
      ACCEPT_TOKEN(anon_sym_DOT);
      END_STATE();
    case 29:
      ACCEPT_TOKEN(anon_sym_COMMA);
      END_STATE();
    case 30:
      ACCEPT_TOKEN(sym_comment);
      if (lookahead != 0 &&
          lookahead != '\n') ADVANCE(30);
      END_STATE();
    case 31:
      ACCEPT_TOKEN(anon_sym_LT_DASH);
      END_STATE();
    case 32:
      ACCEPT_TOKEN(anon_sym_DASH_GT);
      END_STATE();
    case 33:
      ACCEPT_TOKEN(anon_sym_EQ_GT);
      END_STATE();
    case 34:
      ACCEPT_TOKEN(anon_sym_EQ_EQ);
      END_STATE();
    case 35:
      ACCEPT_TOKEN(anon_sym_BANG_EQ);
      END_STATE();
    case 36:
      ACCEPT_TOKEN(anon_sym_EQ_TILDE);
      END_STATE();
    case 37:
      ACCEPT_TOKEN(anon_sym_BANG_TILDE);
      END_STATE();
    case 38:
      ACCEPT_TOKEN(anon_sym_EQ);
      if (lookahead == '=') ADVANCE(34);
      if (lookahead == '>') ADVANCE(33);
      if (lookahead == '~') ADVANCE(36);
      END_STATE();
    case 39:
      ACCEPT_TOKEN(sym_number);
      if (('0' <= lookahead && lookahead <= '9')) ADVANCE(39);
      END_STATE();
    case 40:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == '.') ADVANCE(17);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(40);
      END_STATE();
    case 41:
      ACCEPT_TOKEN(sym_qualified_identifier);
      if (lookahead == '.') ADVANCE(17);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(41);
      END_STATE();
    case 42:
      ACCEPT_TOKEN(sym_regex);
      END_STATE();
    case 43:
      ACCEPT_TOKEN(sym_string);
      END_STATE();
    case 44:
      ACCEPT_TOKEN(sym_string);
      if (lookahead == '"') ADVANCE(5);
      END_STATE();
    case 45:
      ACCEPT_TOKEN(sym_triple_string);
      END_STATE();
    case 46:
      ACCEPT_TOKEN(sym_backtick_string);
      END_STATE();
    case 47:
      ACCEPT_TOKEN(sym_backtick_string);
      if (lookahead == '`') ADVANCE(48);
      END_STATE();
    case 48:
      ACCEPT_TOKEN(anon_sym_BQUOTE_BQUOTE_BQUOTE);
      END_STATE();
    case 49:
      ACCEPT_TOKEN(sym_fence_language);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(49);
      END_STATE();
    case 50:
      ACCEPT_TOKEN(sym_fence_content);
      if (lookahead == '`') ADVANCE(16);
      if (('\t' <= lookahead && lookahead <= '\r') ||
          lookahead == ' ') ADVANCE(50);
      if (lookahead != 0) ADVANCE(51);
      END_STATE();
    case 51:
      ACCEPT_TOKEN(sym_fence_content);
      if (lookahead == '`') ADVANCE(13);
      if (lookahead != 0) ADVANCE(51);
      END_STATE();
    default:
      return false;
  }
}

static bool ts_lex_keywords(TSLexer *lexer, TSStateId state) {
  START_LEXER();
  eof = lexer->eof(lexer);
  switch (state) {
    case 0:
      ADVANCE_MAP(
        'a', 1,
        'c', 2,
        'd', 3,
        'e', 4,
        'f', 5,
        'i', 6,
        'l', 7,
        'm', 8,
        'n', 9,
        'p', 10,
        'r', 11,
        's', 12,
        't', 13,
        'u', 14,
      );
      if (('\t' <= lookahead && lookahead <= '\r') ||
          lookahead == ' ') SKIP(0);
      END_STATE();
    case 1:
      if (lookahead == 'l') ADVANCE(15);
      if (lookahead == 's') ADVANCE(16);
      END_STATE();
    case 2:
      if (lookahead == 'a') ADVANCE(17);
      if (lookahead == 'h') ADVANCE(18);
      if (lookahead == 'o') ADVANCE(19);
      END_STATE();
    case 3:
      if (lookahead == 'e') ADVANCE(20);
      END_STATE();
    case 4:
      if (lookahead == 'l') ADVANCE(21);
      if (lookahead == 'x') ADVANCE(22);
      END_STATE();
    case 5:
      if (lookahead == 'a') ADVANCE(23);
      if (lookahead == 'o') ADVANCE(24);
      END_STATE();
    case 6:
      if (lookahead == 'f') ADVANCE(25);
      if (lookahead == 'm') ADVANCE(26);
      if (lookahead == 'n') ADVANCE(27);
      END_STATE();
    case 7:
      if (lookahead == 'o') ADVANCE(28);
      END_STATE();
    case 8:
      if (lookahead == 'a') ADVANCE(29);
      if (lookahead == 'o') ADVANCE(30);
      END_STATE();
    case 9:
      if (lookahead == 'o') ADVANCE(31);
      END_STATE();
    case 10:
      if (lookahead == 'r') ADVANCE(32);
      END_STATE();
    case 11:
      if (lookahead == 'e') ADVANCE(33);
      if (lookahead == 'u') ADVANCE(34);
      END_STATE();
    case 12:
      if (lookahead == 'c') ADVANCE(35);
      if (lookahead == 'e') ADVANCE(36);
      END_STATE();
    case 13:
      if (lookahead == 'e') ADVANCE(37);
      if (lookahead == 'r') ADVANCE(38);
      END_STATE();
    case 14:
      if (lookahead == 's') ADVANCE(39);
      END_STATE();
    case 15:
      if (lookahead == 'l') ADVANCE(40);
      END_STATE();
    case 16:
      ACCEPT_TOKEN(anon_sym_as);
      if (lookahead == 'y') ADVANCE(41);
      END_STATE();
    case 17:
      if (lookahead == 't') ADVANCE(42);
      END_STATE();
    case 18:
      if (lookahead == 'a') ADVANCE(43);
      END_STATE();
    case 19:
      if (lookahead == 'n') ADVANCE(44);
      END_STATE();
    case 20:
      if (lookahead == 'f') ADVANCE(45);
      END_STATE();
    case 21:
      if (lookahead == 's') ADVANCE(46);
      END_STATE();
    case 22:
      if (lookahead == 'p') ADVANCE(47);
      END_STATE();
    case 23:
      if (lookahead == 'i') ADVANCE(48);
      if (lookahead == 'l') ADVANCE(49);
      END_STATE();
    case 24:
      if (lookahead == 'r') ADVANCE(50);
      END_STATE();
    case 25:
      ACCEPT_TOKEN(anon_sym_if);
      END_STATE();
    case 26:
      if (lookahead == 'p') ADVANCE(51);
      END_STATE();
    case 27:
      ACCEPT_TOKEN(anon_sym_in);
      END_STATE();
    case 28:
      if (lookahead == 'g') ADVANCE(52);
      END_STATE();
    case 29:
      if (lookahead == 't') ADVANCE(53);
      END_STATE();
    case 30:
      if (lookahead == 'c') ADVANCE(54);
      END_STATE();
    case 31:
      if (lookahead == 't') ADVANCE(55);
      END_STATE();
    case 32:
      if (lookahead == 'o') ADVANCE(56);
      END_STATE();
    case 33:
      if (lookahead == 'c') ADVANCE(57);
      if (lookahead == 't') ADVANCE(58);
      END_STATE();
    case 34:
      if (lookahead == 'n') ADVANCE(59);
      END_STATE();
    case 35:
      if (lookahead == 'r') ADVANCE(60);
      END_STATE();
    case 36:
      if (lookahead == 'n') ADVANCE(61);
      END_STATE();
    case 37:
      if (lookahead == 's') ADVANCE(62);
      END_STATE();
    case 38:
      if (lookahead == 'u') ADVANCE(63);
      END_STATE();
    case 39:
      if (lookahead == 'e') ADVANCE(64);
      END_STATE();
    case 40:
      if (lookahead == 'o') ADVANCE(65);
      END_STATE();
    case 41:
      if (lookahead == 'n') ADVANCE(66);
      END_STATE();
    case 42:
      if (lookahead == 'c') ADVANCE(67);
      END_STATE();
    case 43:
      if (lookahead == 'n') ADVANCE(68);
      END_STATE();
    case 44:
      if (lookahead == 'f') ADVANCE(69);
      if (lookahead == 's') ADVANCE(70);
      END_STATE();
    case 45:
      ACCEPT_TOKEN(anon_sym_def);
      END_STATE();
    case 46:
      if (lookahead == 'e') ADVANCE(71);
      END_STATE();
    case 47:
      if (lookahead == 'e') ADVANCE(72);
      if (lookahead == 'o') ADVANCE(73);
      END_STATE();
    case 48:
      if (lookahead == 'l') ADVANCE(74);
      END_STATE();
    case 49:
      if (lookahead == 's') ADVANCE(75);
      END_STATE();
    case 50:
      ACCEPT_TOKEN(anon_sym_for);
      END_STATE();
    case 51:
      if (lookahead == 'o') ADVANCE(76);
      END_STATE();
    case 52:
      ACCEPT_TOKEN(anon_sym_log);
      if (lookahead == 'e') ADVANCE(77);
      if (lookahead == 'w') ADVANCE(78);
      END_STATE();
    case 53:
      if (lookahead == 'c') ADVANCE(79);
      END_STATE();
    case 54:
      if (lookahead == 'k') ADVANCE(80);
      END_STATE();
    case 55:
      ACCEPT_TOKEN(anon_sym_not);
      END_STATE();
    case 56:
      if (lookahead == 'm') ADVANCE(81);
      END_STATE();
    case 57:
      if (lookahead == 'o') ADVANCE(82);
      END_STATE();
    case 58:
      if (lookahead == 'u') ADVANCE(83);
      END_STATE();
    case 59:
      ACCEPT_TOKEN(anon_sym_run);
      END_STATE();
    case 60:
      if (lookahead == 'i') ADVANCE(84);
      END_STATE();
    case 61:
      if (lookahead == 'd') ADVANCE(85);
      END_STATE();
    case 62:
      if (lookahead == 't') ADVANCE(86);
      END_STATE();
    case 63:
      if (lookahead == 'e') ADVANCE(87);
      END_STATE();
    case 64:
      ACCEPT_TOKEN(anon_sym_use);
      END_STATE();
    case 65:
      if (lookahead == 'w') ADVANCE(88);
      END_STATE();
    case 66:
      if (lookahead == 'c') ADVANCE(89);
      END_STATE();
    case 67:
      if (lookahead == 'h') ADVANCE(90);
      END_STATE();
    case 68:
      if (lookahead == 'n') ADVANCE(91);
      END_STATE();
    case 69:
      if (lookahead == 'i') ADVANCE(92);
      END_STATE();
    case 70:
      if (lookahead == 't') ADVANCE(93);
      END_STATE();
    case 71:
      ACCEPT_TOKEN(anon_sym_else);
      END_STATE();
    case 72:
      if (lookahead == 'c') ADVANCE(94);
      END_STATE();
    case 73:
      if (lookahead == 'r') ADVANCE(95);
      END_STATE();
    case 74:
      ACCEPT_TOKEN(anon_sym_fail);
      END_STATE();
    case 75:
      if (lookahead == 'e') ADVANCE(96);
      END_STATE();
    case 76:
      if (lookahead == 'r') ADVANCE(97);
      END_STATE();
    case 77:
      if (lookahead == 'r') ADVANCE(98);
      END_STATE();
    case 78:
      if (lookahead == 'a') ADVANCE(99);
      END_STATE();
    case 79:
      if (lookahead == 'h') ADVANCE(100);
      END_STATE();
    case 80:
      ACCEPT_TOKEN(anon_sym_mock);
      END_STATE();
    case 81:
      if (lookahead == 'p') ADVANCE(101);
      END_STATE();
    case 82:
      if (lookahead == 'v') ADVANCE(102);
      END_STATE();
    case 83:
      if (lookahead == 'r') ADVANCE(103);
      END_STATE();
    case 84:
      if (lookahead == 'p') ADVANCE(104);
      END_STATE();
    case 85:
      ACCEPT_TOKEN(anon_sym_send);
      END_STATE();
    case 86:
      ACCEPT_TOKEN(anon_sym_test);
      END_STATE();
    case 87:
      ACCEPT_TOKEN(anon_sym_true);
      END_STATE();
    case 88:
      if (lookahead == '_') ADVANCE(105);
      END_STATE();
    case 89:
      ACCEPT_TOKEN(anon_sym_async);
      END_STATE();
    case 90:
      ACCEPT_TOKEN(anon_sym_catch);
      END_STATE();
    case 91:
      if (lookahead == 'e') ADVANCE(106);
      END_STATE();
    case 92:
      if (lookahead == 'g') ADVANCE(107);
      END_STATE();
    case 93:
      ACCEPT_TOKEN(anon_sym_const);
      END_STATE();
    case 94:
      if (lookahead == 't') ADVANCE(108);
      END_STATE();
    case 95:
      if (lookahead == 't') ADVANCE(109);
      END_STATE();
    case 96:
      ACCEPT_TOKEN(anon_sym_false);
      END_STATE();
    case 97:
      if (lookahead == 't') ADVANCE(110);
      END_STATE();
    case 98:
      if (lookahead == 'r') ADVANCE(111);
      END_STATE();
    case 99:
      if (lookahead == 'r') ADVANCE(112);
      END_STATE();
    case 100:
      ACCEPT_TOKEN(anon_sym_match);
      END_STATE();
    case 101:
      if (lookahead == 't') ADVANCE(113);
      END_STATE();
    case 102:
      if (lookahead == 'e') ADVANCE(114);
      END_STATE();
    case 103:
      if (lookahead == 'n') ADVANCE(115);
      END_STATE();
    case 104:
      if (lookahead == 't') ADVANCE(116);
      END_STATE();
    case 105:
      if (lookahead == 'f') ADVANCE(117);
      END_STATE();
    case 106:
      if (lookahead == 'l') ADVANCE(118);
      END_STATE();
    case 107:
      ACCEPT_TOKEN(anon_sym_config);
      END_STATE();
    case 108:
      if (lookahead == '_') ADVANCE(119);
      END_STATE();
    case 109:
      ACCEPT_TOKEN(anon_sym_export);
      END_STATE();
    case 110:
      ACCEPT_TOKEN(anon_sym_import);
      END_STATE();
    case 111:
      ACCEPT_TOKEN(anon_sym_logerr);
      END_STATE();
    case 112:
      if (lookahead == 'n') ADVANCE(120);
      END_STATE();
    case 113:
      ACCEPT_TOKEN(anon_sym_prompt);
      END_STATE();
    case 114:
      if (lookahead == 'r') ADVANCE(121);
      END_STATE();
    case 115:
      ACCEPT_TOKEN(anon_sym_return);
      if (lookahead == 's') ADVANCE(122);
      END_STATE();
    case 116:
      ACCEPT_TOKEN(anon_sym_script);
      END_STATE();
    case 117:
      if (lookahead == 'a') ADVANCE(123);
      END_STATE();
    case 118:
      ACCEPT_TOKEN(anon_sym_channel);
      END_STATE();
    case 119:
      if (lookahead == 'c') ADVANCE(124);
      if (lookahead == 'e') ADVANCE(125);
      if (lookahead == 'n') ADVANCE(126);
      END_STATE();
    case 120:
      ACCEPT_TOKEN(anon_sym_logwarn);
      END_STATE();
    case 121:
      ACCEPT_TOKEN(anon_sym_recover);
      END_STATE();
    case 122:
      ACCEPT_TOKEN(anon_sym_returns);
      END_STATE();
    case 123:
      if (lookahead == 'i') ADVANCE(127);
      END_STATE();
    case 124:
      if (lookahead == 'o') ADVANCE(128);
      END_STATE();
    case 125:
      if (lookahead == 'q') ADVANCE(129);
      END_STATE();
    case 126:
      if (lookahead == 'o') ADVANCE(130);
      END_STATE();
    case 127:
      if (lookahead == 'l') ADVANCE(131);
      END_STATE();
    case 128:
      if (lookahead == 'n') ADVANCE(132);
      END_STATE();
    case 129:
      if (lookahead == 'u') ADVANCE(133);
      END_STATE();
    case 130:
      if (lookahead == 't') ADVANCE(134);
      END_STATE();
    case 131:
      if (lookahead == 'u') ADVANCE(135);
      END_STATE();
    case 132:
      if (lookahead == 't') ADVANCE(136);
      END_STATE();
    case 133:
      if (lookahead == 'a') ADVANCE(137);
      END_STATE();
    case 134:
      if (lookahead == '_') ADVANCE(138);
      END_STATE();
    case 135:
      if (lookahead == 'r') ADVANCE(139);
      END_STATE();
    case 136:
      if (lookahead == 'a') ADVANCE(140);
      END_STATE();
    case 137:
      if (lookahead == 'l') ADVANCE(141);
      END_STATE();
    case 138:
      if (lookahead == 'c') ADVANCE(142);
      END_STATE();
    case 139:
      if (lookahead == 'e') ADVANCE(143);
      END_STATE();
    case 140:
      if (lookahead == 'i') ADVANCE(144);
      END_STATE();
    case 141:
      ACCEPT_TOKEN(anon_sym_expect_equal);
      END_STATE();
    case 142:
      if (lookahead == 'o') ADVANCE(145);
      END_STATE();
    case 143:
      ACCEPT_TOKEN(anon_sym_allow_failure);
      END_STATE();
    case 144:
      if (lookahead == 'n') ADVANCE(146);
      END_STATE();
    case 145:
      if (lookahead == 'n') ADVANCE(147);
      END_STATE();
    case 146:
      ACCEPT_TOKEN(anon_sym_expect_contain);
      END_STATE();
    case 147:
      if (lookahead == 't') ADVANCE(148);
      END_STATE();
    case 148:
      if (lookahead == 'a') ADVANCE(149);
      END_STATE();
    case 149:
      if (lookahead == 'i') ADVANCE(150);
      END_STATE();
    case 150:
      if (lookahead == 'n') ADVANCE(151);
      END_STATE();
    case 151:
      ACCEPT_TOKEN(anon_sym_expect_not_contain);
      END_STATE();
    default:
      return false;
  }
}

static const TSLexMode ts_lex_modes[STATE_COUNT] = {
  [0] = {.lex_state = 0},
  [1] = {.lex_state = 0},
  [2] = {.lex_state = 0},
  [3] = {.lex_state = 0},
  [4] = {.lex_state = 0},
  [5] = {.lex_state = 0},
  [6] = {.lex_state = 0},
  [7] = {.lex_state = 0},
  [8] = {.lex_state = 0},
  [9] = {.lex_state = 14},
  [10] = {.lex_state = 15},
  [11] = {.lex_state = 0},
  [12] = {.lex_state = 0},
  [13] = {.lex_state = 0},
};

static const uint16_t ts_parse_table[LARGE_STATE_COUNT][SYMBOL_COUNT] = {
  [0] = {
    [ts_builtin_sym_end] = ACTIONS(1),
    [sym_identifier] = ACTIONS(1),
    [anon_sym_import] = ACTIONS(1),
    [anon_sym_export] = ACTIONS(1),
    [anon_sym_as] = ACTIONS(1),
    [anon_sym_config] = ACTIONS(1),
    [anon_sym_channel] = ACTIONS(1),
    [anon_sym_script] = ACTIONS(1),
    [anon_sym_def] = ACTIONS(1),
    [anon_sym_test] = ACTIONS(1),
    [anon_sym_use] = ACTIONS(1),
    [anon_sym_const] = ACTIONS(1),
    [anon_sym_run] = ACTIONS(1),
    [anon_sym_prompt] = ACTIONS(1),
    [anon_sym_log] = ACTIONS(1),
    [anon_sym_logerr] = ACTIONS(1),
    [anon_sym_logwarn] = ACTIONS(1),
    [anon_sym_fail] = ACTIONS(1),
    [anon_sym_return] = ACTIONS(1),
    [anon_sym_send] = ACTIONS(1),
    [anon_sym_recover] = ACTIONS(1),
    [anon_sym_catch] = ACTIONS(1),
    [anon_sym_if] = ACTIONS(1),
    [anon_sym_else] = ACTIONS(1),
    [anon_sym_for] = ACTIONS(1),
    [anon_sym_in] = ACTIONS(1),
    [anon_sym_match] = ACTIONS(1),
    [anon_sym_async] = ACTIONS(1),
    [anon_sym_returns] = ACTIONS(1),
    [anon_sym_not] = ACTIONS(1),
    [anon_sym_mock] = ACTIONS(1),
    [anon_sym_allow_failure] = ACTIONS(1),
    [anon_sym_expect_contain] = ACTIONS(1),
    [anon_sym_expect_not_contain] = ACTIONS(1),
    [anon_sym_expect_equal] = ACTIONS(1),
    [anon_sym_true] = ACTIONS(1),
    [anon_sym_false] = ACTIONS(1),
    [anon_sym_LBRACE] = ACTIONS(1),
    [anon_sym_RBRACE] = ACTIONS(1),
    [anon_sym_LPAREN] = ACTIONS(1),
    [anon_sym_RPAREN] = ACTIONS(1),
    [anon_sym_LBRACK] = ACTIONS(1),
    [anon_sym_RBRACK] = ACTIONS(1),
    [anon_sym_DOT] = ACTIONS(1),
    [anon_sym_COMMA] = ACTIONS(1),
    [sym_comment] = ACTIONS(1),
    [anon_sym_LT_DASH] = ACTIONS(1),
    [anon_sym_DASH_GT] = ACTIONS(1),
    [anon_sym_EQ_GT] = ACTIONS(1),
    [anon_sym_EQ_EQ] = ACTIONS(1),
    [anon_sym_BANG_EQ] = ACTIONS(1),
    [anon_sym_EQ_TILDE] = ACTIONS(1),
    [anon_sym_BANG_TILDE] = ACTIONS(1),
    [anon_sym_EQ] = ACTIONS(1),
    [sym_number] = ACTIONS(1),
    [sym_qualified_identifier] = ACTIONS(1),
    [sym_regex] = ACTIONS(1),
    [sym_string] = ACTIONS(1),
    [sym_triple_string] = ACTIONS(1),
    [sym_backtick_string] = ACTIONS(1),
    [anon_sym_BQUOTE_BQUOTE_BQUOTE] = ACTIONS(1),
  },
  [1] = {
    [sym_source_file] = STATE(11),
    [sym__token] = STATE(2),
    [sym_operator] = STATE(2),
    [sym_fenced_block] = STATE(2),
    [aux_sym_source_file_repeat1] = STATE(2),
    [ts_builtin_sym_end] = ACTIONS(3),
    [sym_identifier] = ACTIONS(5),
    [anon_sym_import] = ACTIONS(5),
    [anon_sym_export] = ACTIONS(5),
    [anon_sym_as] = ACTIONS(5),
    [anon_sym_config] = ACTIONS(5),
    [anon_sym_channel] = ACTIONS(5),
    [anon_sym_script] = ACTIONS(5),
    [anon_sym_def] = ACTIONS(5),
    [anon_sym_test] = ACTIONS(5),
    [anon_sym_use] = ACTIONS(5),
    [anon_sym_const] = ACTIONS(5),
    [anon_sym_run] = ACTIONS(5),
    [anon_sym_prompt] = ACTIONS(5),
    [anon_sym_log] = ACTIONS(5),
    [anon_sym_logerr] = ACTIONS(5),
    [anon_sym_logwarn] = ACTIONS(5),
    [anon_sym_fail] = ACTIONS(5),
    [anon_sym_return] = ACTIONS(5),
    [anon_sym_send] = ACTIONS(5),
    [anon_sym_recover] = ACTIONS(5),
    [anon_sym_catch] = ACTIONS(5),
    [anon_sym_if] = ACTIONS(5),
    [anon_sym_else] = ACTIONS(5),
    [anon_sym_for] = ACTIONS(5),
    [anon_sym_in] = ACTIONS(5),
    [anon_sym_match] = ACTIONS(5),
    [anon_sym_async] = ACTIONS(5),
    [anon_sym_returns] = ACTIONS(5),
    [anon_sym_not] = ACTIONS(5),
    [anon_sym_mock] = ACTIONS(5),
    [anon_sym_allow_failure] = ACTIONS(5),
    [anon_sym_expect_contain] = ACTIONS(5),
    [anon_sym_expect_not_contain] = ACTIONS(5),
    [anon_sym_expect_equal] = ACTIONS(5),
    [anon_sym_true] = ACTIONS(5),
    [anon_sym_false] = ACTIONS(5),
    [anon_sym_LBRACE] = ACTIONS(7),
    [anon_sym_RBRACE] = ACTIONS(7),
    [anon_sym_LPAREN] = ACTIONS(7),
    [anon_sym_RPAREN] = ACTIONS(7),
    [anon_sym_LBRACK] = ACTIONS(7),
    [anon_sym_RBRACK] = ACTIONS(7),
    [anon_sym_DOT] = ACTIONS(7),
    [anon_sym_COMMA] = ACTIONS(7),
    [sym_comment] = ACTIONS(7),
    [anon_sym_LT_DASH] = ACTIONS(9),
    [anon_sym_DASH_GT] = ACTIONS(9),
    [anon_sym_EQ_GT] = ACTIONS(9),
    [anon_sym_EQ_EQ] = ACTIONS(9),
    [anon_sym_BANG_EQ] = ACTIONS(9),
    [anon_sym_EQ_TILDE] = ACTIONS(9),
    [anon_sym_BANG_TILDE] = ACTIONS(9),
    [anon_sym_EQ] = ACTIONS(11),
    [sym_number] = ACTIONS(7),
    [sym_qualified_identifier] = ACTIONS(7),
    [sym_regex] = ACTIONS(7),
    [sym_string] = ACTIONS(5),
    [sym_triple_string] = ACTIONS(7),
    [sym_backtick_string] = ACTIONS(5),
    [anon_sym_BQUOTE_BQUOTE_BQUOTE] = ACTIONS(13),
  },
  [2] = {
    [sym__token] = STATE(3),
    [sym_operator] = STATE(3),
    [sym_fenced_block] = STATE(3),
    [aux_sym_source_file_repeat1] = STATE(3),
    [ts_builtin_sym_end] = ACTIONS(15),
    [sym_identifier] = ACTIONS(17),
    [anon_sym_import] = ACTIONS(17),
    [anon_sym_export] = ACTIONS(17),
    [anon_sym_as] = ACTIONS(17),
    [anon_sym_config] = ACTIONS(17),
    [anon_sym_channel] = ACTIONS(17),
    [anon_sym_script] = ACTIONS(17),
    [anon_sym_def] = ACTIONS(17),
    [anon_sym_test] = ACTIONS(17),
    [anon_sym_use] = ACTIONS(17),
    [anon_sym_const] = ACTIONS(17),
    [anon_sym_run] = ACTIONS(17),
    [anon_sym_prompt] = ACTIONS(17),
    [anon_sym_log] = ACTIONS(17),
    [anon_sym_logerr] = ACTIONS(17),
    [anon_sym_logwarn] = ACTIONS(17),
    [anon_sym_fail] = ACTIONS(17),
    [anon_sym_return] = ACTIONS(17),
    [anon_sym_send] = ACTIONS(17),
    [anon_sym_recover] = ACTIONS(17),
    [anon_sym_catch] = ACTIONS(17),
    [anon_sym_if] = ACTIONS(17),
    [anon_sym_else] = ACTIONS(17),
    [anon_sym_for] = ACTIONS(17),
    [anon_sym_in] = ACTIONS(17),
    [anon_sym_match] = ACTIONS(17),
    [anon_sym_async] = ACTIONS(17),
    [anon_sym_returns] = ACTIONS(17),
    [anon_sym_not] = ACTIONS(17),
    [anon_sym_mock] = ACTIONS(17),
    [anon_sym_allow_failure] = ACTIONS(17),
    [anon_sym_expect_contain] = ACTIONS(17),
    [anon_sym_expect_not_contain] = ACTIONS(17),
    [anon_sym_expect_equal] = ACTIONS(17),
    [anon_sym_true] = ACTIONS(17),
    [anon_sym_false] = ACTIONS(17),
    [anon_sym_LBRACE] = ACTIONS(19),
    [anon_sym_RBRACE] = ACTIONS(19),
    [anon_sym_LPAREN] = ACTIONS(19),
    [anon_sym_RPAREN] = ACTIONS(19),
    [anon_sym_LBRACK] = ACTIONS(19),
    [anon_sym_RBRACK] = ACTIONS(19),
    [anon_sym_DOT] = ACTIONS(19),
    [anon_sym_COMMA] = ACTIONS(19),
    [sym_comment] = ACTIONS(19),
    [anon_sym_LT_DASH] = ACTIONS(9),
    [anon_sym_DASH_GT] = ACTIONS(9),
    [anon_sym_EQ_GT] = ACTIONS(9),
    [anon_sym_EQ_EQ] = ACTIONS(9),
    [anon_sym_BANG_EQ] = ACTIONS(9),
    [anon_sym_EQ_TILDE] = ACTIONS(9),
    [anon_sym_BANG_TILDE] = ACTIONS(9),
    [anon_sym_EQ] = ACTIONS(11),
    [sym_number] = ACTIONS(19),
    [sym_qualified_identifier] = ACTIONS(19),
    [sym_regex] = ACTIONS(19),
    [sym_string] = ACTIONS(17),
    [sym_triple_string] = ACTIONS(19),
    [sym_backtick_string] = ACTIONS(17),
    [anon_sym_BQUOTE_BQUOTE_BQUOTE] = ACTIONS(13),
  },
  [3] = {
    [sym__token] = STATE(3),
    [sym_operator] = STATE(3),
    [sym_fenced_block] = STATE(3),
    [aux_sym_source_file_repeat1] = STATE(3),
    [ts_builtin_sym_end] = ACTIONS(21),
    [sym_identifier] = ACTIONS(23),
    [anon_sym_import] = ACTIONS(23),
    [anon_sym_export] = ACTIONS(23),
    [anon_sym_as] = ACTIONS(23),
    [anon_sym_config] = ACTIONS(23),
    [anon_sym_channel] = ACTIONS(23),
    [anon_sym_script] = ACTIONS(23),
    [anon_sym_def] = ACTIONS(23),
    [anon_sym_test] = ACTIONS(23),
    [anon_sym_use] = ACTIONS(23),
    [anon_sym_const] = ACTIONS(23),
    [anon_sym_run] = ACTIONS(23),
    [anon_sym_prompt] = ACTIONS(23),
    [anon_sym_log] = ACTIONS(23),
    [anon_sym_logerr] = ACTIONS(23),
    [anon_sym_logwarn] = ACTIONS(23),
    [anon_sym_fail] = ACTIONS(23),
    [anon_sym_return] = ACTIONS(23),
    [anon_sym_send] = ACTIONS(23),
    [anon_sym_recover] = ACTIONS(23),
    [anon_sym_catch] = ACTIONS(23),
    [anon_sym_if] = ACTIONS(23),
    [anon_sym_else] = ACTIONS(23),
    [anon_sym_for] = ACTIONS(23),
    [anon_sym_in] = ACTIONS(23),
    [anon_sym_match] = ACTIONS(23),
    [anon_sym_async] = ACTIONS(23),
    [anon_sym_returns] = ACTIONS(23),
    [anon_sym_not] = ACTIONS(23),
    [anon_sym_mock] = ACTIONS(23),
    [anon_sym_allow_failure] = ACTIONS(23),
    [anon_sym_expect_contain] = ACTIONS(23),
    [anon_sym_expect_not_contain] = ACTIONS(23),
    [anon_sym_expect_equal] = ACTIONS(23),
    [anon_sym_true] = ACTIONS(23),
    [anon_sym_false] = ACTIONS(23),
    [anon_sym_LBRACE] = ACTIONS(26),
    [anon_sym_RBRACE] = ACTIONS(26),
    [anon_sym_LPAREN] = ACTIONS(26),
    [anon_sym_RPAREN] = ACTIONS(26),
    [anon_sym_LBRACK] = ACTIONS(26),
    [anon_sym_RBRACK] = ACTIONS(26),
    [anon_sym_DOT] = ACTIONS(26),
    [anon_sym_COMMA] = ACTIONS(26),
    [sym_comment] = ACTIONS(26),
    [anon_sym_LT_DASH] = ACTIONS(29),
    [anon_sym_DASH_GT] = ACTIONS(29),
    [anon_sym_EQ_GT] = ACTIONS(29),
    [anon_sym_EQ_EQ] = ACTIONS(29),
    [anon_sym_BANG_EQ] = ACTIONS(29),
    [anon_sym_EQ_TILDE] = ACTIONS(29),
    [anon_sym_BANG_TILDE] = ACTIONS(29),
    [anon_sym_EQ] = ACTIONS(32),
    [sym_number] = ACTIONS(26),
    [sym_qualified_identifier] = ACTIONS(26),
    [sym_regex] = ACTIONS(26),
    [sym_string] = ACTIONS(23),
    [sym_triple_string] = ACTIONS(26),
    [sym_backtick_string] = ACTIONS(23),
    [anon_sym_BQUOTE_BQUOTE_BQUOTE] = ACTIONS(35),
  },
  [4] = {
    [ts_builtin_sym_end] = ACTIONS(38),
    [sym_identifier] = ACTIONS(40),
    [anon_sym_import] = ACTIONS(40),
    [anon_sym_export] = ACTIONS(40),
    [anon_sym_as] = ACTIONS(40),
    [anon_sym_config] = ACTIONS(40),
    [anon_sym_channel] = ACTIONS(40),
    [anon_sym_script] = ACTIONS(40),
    [anon_sym_def] = ACTIONS(40),
    [anon_sym_test] = ACTIONS(40),
    [anon_sym_use] = ACTIONS(40),
    [anon_sym_const] = ACTIONS(40),
    [anon_sym_run] = ACTIONS(40),
    [anon_sym_prompt] = ACTIONS(40),
    [anon_sym_log] = ACTIONS(40),
    [anon_sym_logerr] = ACTIONS(40),
    [anon_sym_logwarn] = ACTIONS(40),
    [anon_sym_fail] = ACTIONS(40),
    [anon_sym_return] = ACTIONS(40),
    [anon_sym_send] = ACTIONS(40),
    [anon_sym_recover] = ACTIONS(40),
    [anon_sym_catch] = ACTIONS(40),
    [anon_sym_if] = ACTIONS(40),
    [anon_sym_else] = ACTIONS(40),
    [anon_sym_for] = ACTIONS(40),
    [anon_sym_in] = ACTIONS(40),
    [anon_sym_match] = ACTIONS(40),
    [anon_sym_async] = ACTIONS(40),
    [anon_sym_returns] = ACTIONS(40),
    [anon_sym_not] = ACTIONS(40),
    [anon_sym_mock] = ACTIONS(40),
    [anon_sym_allow_failure] = ACTIONS(40),
    [anon_sym_expect_contain] = ACTIONS(40),
    [anon_sym_expect_not_contain] = ACTIONS(40),
    [anon_sym_expect_equal] = ACTIONS(40),
    [anon_sym_true] = ACTIONS(40),
    [anon_sym_false] = ACTIONS(40),
    [anon_sym_LBRACE] = ACTIONS(38),
    [anon_sym_RBRACE] = ACTIONS(38),
    [anon_sym_LPAREN] = ACTIONS(38),
    [anon_sym_RPAREN] = ACTIONS(38),
    [anon_sym_LBRACK] = ACTIONS(38),
    [anon_sym_RBRACK] = ACTIONS(38),
    [anon_sym_DOT] = ACTIONS(38),
    [anon_sym_COMMA] = ACTIONS(38),
    [sym_comment] = ACTIONS(38),
    [anon_sym_LT_DASH] = ACTIONS(38),
    [anon_sym_DASH_GT] = ACTIONS(38),
    [anon_sym_EQ_GT] = ACTIONS(38),
    [anon_sym_EQ_EQ] = ACTIONS(38),
    [anon_sym_BANG_EQ] = ACTIONS(38),
    [anon_sym_EQ_TILDE] = ACTIONS(38),
    [anon_sym_BANG_TILDE] = ACTIONS(38),
    [anon_sym_EQ] = ACTIONS(40),
    [sym_number] = ACTIONS(38),
    [sym_qualified_identifier] = ACTIONS(38),
    [sym_regex] = ACTIONS(38),
    [sym_string] = ACTIONS(40),
    [sym_triple_string] = ACTIONS(38),
    [sym_backtick_string] = ACTIONS(40),
    [anon_sym_BQUOTE_BQUOTE_BQUOTE] = ACTIONS(38),
  },
  [5] = {
    [ts_builtin_sym_end] = ACTIONS(42),
    [sym_identifier] = ACTIONS(44),
    [anon_sym_import] = ACTIONS(44),
    [anon_sym_export] = ACTIONS(44),
    [anon_sym_as] = ACTIONS(44),
    [anon_sym_config] = ACTIONS(44),
    [anon_sym_channel] = ACTIONS(44),
    [anon_sym_script] = ACTIONS(44),
    [anon_sym_def] = ACTIONS(44),
    [anon_sym_test] = ACTIONS(44),
    [anon_sym_use] = ACTIONS(44),
    [anon_sym_const] = ACTIONS(44),
    [anon_sym_run] = ACTIONS(44),
    [anon_sym_prompt] = ACTIONS(44),
    [anon_sym_log] = ACTIONS(44),
    [anon_sym_logerr] = ACTIONS(44),
    [anon_sym_logwarn] = ACTIONS(44),
    [anon_sym_fail] = ACTIONS(44),
    [anon_sym_return] = ACTIONS(44),
    [anon_sym_send] = ACTIONS(44),
    [anon_sym_recover] = ACTIONS(44),
    [anon_sym_catch] = ACTIONS(44),
    [anon_sym_if] = ACTIONS(44),
    [anon_sym_else] = ACTIONS(44),
    [anon_sym_for] = ACTIONS(44),
    [anon_sym_in] = ACTIONS(44),
    [anon_sym_match] = ACTIONS(44),
    [anon_sym_async] = ACTIONS(44),
    [anon_sym_returns] = ACTIONS(44),
    [anon_sym_not] = ACTIONS(44),
    [anon_sym_mock] = ACTIONS(44),
    [anon_sym_allow_failure] = ACTIONS(44),
    [anon_sym_expect_contain] = ACTIONS(44),
    [anon_sym_expect_not_contain] = ACTIONS(44),
    [anon_sym_expect_equal] = ACTIONS(44),
    [anon_sym_true] = ACTIONS(44),
    [anon_sym_false] = ACTIONS(44),
    [anon_sym_LBRACE] = ACTIONS(42),
    [anon_sym_RBRACE] = ACTIONS(42),
    [anon_sym_LPAREN] = ACTIONS(42),
    [anon_sym_RPAREN] = ACTIONS(42),
    [anon_sym_LBRACK] = ACTIONS(42),
    [anon_sym_RBRACK] = ACTIONS(42),
    [anon_sym_DOT] = ACTIONS(42),
    [anon_sym_COMMA] = ACTIONS(42),
    [sym_comment] = ACTIONS(42),
    [anon_sym_LT_DASH] = ACTIONS(42),
    [anon_sym_DASH_GT] = ACTIONS(42),
    [anon_sym_EQ_GT] = ACTIONS(42),
    [anon_sym_EQ_EQ] = ACTIONS(42),
    [anon_sym_BANG_EQ] = ACTIONS(42),
    [anon_sym_EQ_TILDE] = ACTIONS(42),
    [anon_sym_BANG_TILDE] = ACTIONS(42),
    [anon_sym_EQ] = ACTIONS(44),
    [sym_number] = ACTIONS(42),
    [sym_qualified_identifier] = ACTIONS(42),
    [sym_regex] = ACTIONS(42),
    [sym_string] = ACTIONS(44),
    [sym_triple_string] = ACTIONS(42),
    [sym_backtick_string] = ACTIONS(44),
    [anon_sym_BQUOTE_BQUOTE_BQUOTE] = ACTIONS(42),
  },
  [6] = {
    [ts_builtin_sym_end] = ACTIONS(46),
    [sym_identifier] = ACTIONS(48),
    [anon_sym_import] = ACTIONS(48),
    [anon_sym_export] = ACTIONS(48),
    [anon_sym_as] = ACTIONS(48),
    [anon_sym_config] = ACTIONS(48),
    [anon_sym_channel] = ACTIONS(48),
    [anon_sym_script] = ACTIONS(48),
    [anon_sym_def] = ACTIONS(48),
    [anon_sym_test] = ACTIONS(48),
    [anon_sym_use] = ACTIONS(48),
    [anon_sym_const] = ACTIONS(48),
    [anon_sym_run] = ACTIONS(48),
    [anon_sym_prompt] = ACTIONS(48),
    [anon_sym_log] = ACTIONS(48),
    [anon_sym_logerr] = ACTIONS(48),
    [anon_sym_logwarn] = ACTIONS(48),
    [anon_sym_fail] = ACTIONS(48),
    [anon_sym_return] = ACTIONS(48),
    [anon_sym_send] = ACTIONS(48),
    [anon_sym_recover] = ACTIONS(48),
    [anon_sym_catch] = ACTIONS(48),
    [anon_sym_if] = ACTIONS(48),
    [anon_sym_else] = ACTIONS(48),
    [anon_sym_for] = ACTIONS(48),
    [anon_sym_in] = ACTIONS(48),
    [anon_sym_match] = ACTIONS(48),
    [anon_sym_async] = ACTIONS(48),
    [anon_sym_returns] = ACTIONS(48),
    [anon_sym_not] = ACTIONS(48),
    [anon_sym_mock] = ACTIONS(48),
    [anon_sym_allow_failure] = ACTIONS(48),
    [anon_sym_expect_contain] = ACTIONS(48),
    [anon_sym_expect_not_contain] = ACTIONS(48),
    [anon_sym_expect_equal] = ACTIONS(48),
    [anon_sym_true] = ACTIONS(48),
    [anon_sym_false] = ACTIONS(48),
    [anon_sym_LBRACE] = ACTIONS(46),
    [anon_sym_RBRACE] = ACTIONS(46),
    [anon_sym_LPAREN] = ACTIONS(46),
    [anon_sym_RPAREN] = ACTIONS(46),
    [anon_sym_LBRACK] = ACTIONS(46),
    [anon_sym_RBRACK] = ACTIONS(46),
    [anon_sym_DOT] = ACTIONS(46),
    [anon_sym_COMMA] = ACTIONS(46),
    [sym_comment] = ACTIONS(46),
    [anon_sym_LT_DASH] = ACTIONS(46),
    [anon_sym_DASH_GT] = ACTIONS(46),
    [anon_sym_EQ_GT] = ACTIONS(46),
    [anon_sym_EQ_EQ] = ACTIONS(46),
    [anon_sym_BANG_EQ] = ACTIONS(46),
    [anon_sym_EQ_TILDE] = ACTIONS(46),
    [anon_sym_BANG_TILDE] = ACTIONS(46),
    [anon_sym_EQ] = ACTIONS(48),
    [sym_number] = ACTIONS(46),
    [sym_qualified_identifier] = ACTIONS(46),
    [sym_regex] = ACTIONS(46),
    [sym_string] = ACTIONS(48),
    [sym_triple_string] = ACTIONS(46),
    [sym_backtick_string] = ACTIONS(48),
    [anon_sym_BQUOTE_BQUOTE_BQUOTE] = ACTIONS(46),
  },
  [7] = {
    [ts_builtin_sym_end] = ACTIONS(50),
    [sym_identifier] = ACTIONS(52),
    [anon_sym_import] = ACTIONS(52),
    [anon_sym_export] = ACTIONS(52),
    [anon_sym_as] = ACTIONS(52),
    [anon_sym_config] = ACTIONS(52),
    [anon_sym_channel] = ACTIONS(52),
    [anon_sym_script] = ACTIONS(52),
    [anon_sym_def] = ACTIONS(52),
    [anon_sym_test] = ACTIONS(52),
    [anon_sym_use] = ACTIONS(52),
    [anon_sym_const] = ACTIONS(52),
    [anon_sym_run] = ACTIONS(52),
    [anon_sym_prompt] = ACTIONS(52),
    [anon_sym_log] = ACTIONS(52),
    [anon_sym_logerr] = ACTIONS(52),
    [anon_sym_logwarn] = ACTIONS(52),
    [anon_sym_fail] = ACTIONS(52),
    [anon_sym_return] = ACTIONS(52),
    [anon_sym_send] = ACTIONS(52),
    [anon_sym_recover] = ACTIONS(52),
    [anon_sym_catch] = ACTIONS(52),
    [anon_sym_if] = ACTIONS(52),
    [anon_sym_else] = ACTIONS(52),
    [anon_sym_for] = ACTIONS(52),
    [anon_sym_in] = ACTIONS(52),
    [anon_sym_match] = ACTIONS(52),
    [anon_sym_async] = ACTIONS(52),
    [anon_sym_returns] = ACTIONS(52),
    [anon_sym_not] = ACTIONS(52),
    [anon_sym_mock] = ACTIONS(52),
    [anon_sym_allow_failure] = ACTIONS(52),
    [anon_sym_expect_contain] = ACTIONS(52),
    [anon_sym_expect_not_contain] = ACTIONS(52),
    [anon_sym_expect_equal] = ACTIONS(52),
    [anon_sym_true] = ACTIONS(52),
    [anon_sym_false] = ACTIONS(52),
    [anon_sym_LBRACE] = ACTIONS(50),
    [anon_sym_RBRACE] = ACTIONS(50),
    [anon_sym_LPAREN] = ACTIONS(50),
    [anon_sym_RPAREN] = ACTIONS(50),
    [anon_sym_LBRACK] = ACTIONS(50),
    [anon_sym_RBRACK] = ACTIONS(50),
    [anon_sym_DOT] = ACTIONS(50),
    [anon_sym_COMMA] = ACTIONS(50),
    [sym_comment] = ACTIONS(50),
    [anon_sym_LT_DASH] = ACTIONS(50),
    [anon_sym_DASH_GT] = ACTIONS(50),
    [anon_sym_EQ_GT] = ACTIONS(50),
    [anon_sym_EQ_EQ] = ACTIONS(50),
    [anon_sym_BANG_EQ] = ACTIONS(50),
    [anon_sym_EQ_TILDE] = ACTIONS(50),
    [anon_sym_BANG_TILDE] = ACTIONS(50),
    [anon_sym_EQ] = ACTIONS(52),
    [sym_number] = ACTIONS(50),
    [sym_qualified_identifier] = ACTIONS(50),
    [sym_regex] = ACTIONS(50),
    [sym_string] = ACTIONS(52),
    [sym_triple_string] = ACTIONS(50),
    [sym_backtick_string] = ACTIONS(52),
    [anon_sym_BQUOTE_BQUOTE_BQUOTE] = ACTIONS(50),
  },
  [8] = {
    [ts_builtin_sym_end] = ACTIONS(54),
    [sym_identifier] = ACTIONS(56),
    [anon_sym_import] = ACTIONS(56),
    [anon_sym_export] = ACTIONS(56),
    [anon_sym_as] = ACTIONS(56),
    [anon_sym_config] = ACTIONS(56),
    [anon_sym_channel] = ACTIONS(56),
    [anon_sym_script] = ACTIONS(56),
    [anon_sym_def] = ACTIONS(56),
    [anon_sym_test] = ACTIONS(56),
    [anon_sym_use] = ACTIONS(56),
    [anon_sym_const] = ACTIONS(56),
    [anon_sym_run] = ACTIONS(56),
    [anon_sym_prompt] = ACTIONS(56),
    [anon_sym_log] = ACTIONS(56),
    [anon_sym_logerr] = ACTIONS(56),
    [anon_sym_logwarn] = ACTIONS(56),
    [anon_sym_fail] = ACTIONS(56),
    [anon_sym_return] = ACTIONS(56),
    [anon_sym_send] = ACTIONS(56),
    [anon_sym_recover] = ACTIONS(56),
    [anon_sym_catch] = ACTIONS(56),
    [anon_sym_if] = ACTIONS(56),
    [anon_sym_else] = ACTIONS(56),
    [anon_sym_for] = ACTIONS(56),
    [anon_sym_in] = ACTIONS(56),
    [anon_sym_match] = ACTIONS(56),
    [anon_sym_async] = ACTIONS(56),
    [anon_sym_returns] = ACTIONS(56),
    [anon_sym_not] = ACTIONS(56),
    [anon_sym_mock] = ACTIONS(56),
    [anon_sym_allow_failure] = ACTIONS(56),
    [anon_sym_expect_contain] = ACTIONS(56),
    [anon_sym_expect_not_contain] = ACTIONS(56),
    [anon_sym_expect_equal] = ACTIONS(56),
    [anon_sym_true] = ACTIONS(56),
    [anon_sym_false] = ACTIONS(56),
    [anon_sym_LBRACE] = ACTIONS(54),
    [anon_sym_RBRACE] = ACTIONS(54),
    [anon_sym_LPAREN] = ACTIONS(54),
    [anon_sym_RPAREN] = ACTIONS(54),
    [anon_sym_LBRACK] = ACTIONS(54),
    [anon_sym_RBRACK] = ACTIONS(54),
    [anon_sym_DOT] = ACTIONS(54),
    [anon_sym_COMMA] = ACTIONS(54),
    [sym_comment] = ACTIONS(54),
    [anon_sym_LT_DASH] = ACTIONS(54),
    [anon_sym_DASH_GT] = ACTIONS(54),
    [anon_sym_EQ_GT] = ACTIONS(54),
    [anon_sym_EQ_EQ] = ACTIONS(54),
    [anon_sym_BANG_EQ] = ACTIONS(54),
    [anon_sym_EQ_TILDE] = ACTIONS(54),
    [anon_sym_BANG_TILDE] = ACTIONS(54),
    [anon_sym_EQ] = ACTIONS(56),
    [sym_number] = ACTIONS(54),
    [sym_qualified_identifier] = ACTIONS(54),
    [sym_regex] = ACTIONS(54),
    [sym_string] = ACTIONS(56),
    [sym_triple_string] = ACTIONS(54),
    [sym_backtick_string] = ACTIONS(56),
    [anon_sym_BQUOTE_BQUOTE_BQUOTE] = ACTIONS(54),
  },
};

static const uint16_t ts_small_parse_table[] = {
  [0] = 3,
    ACTIONS(58), 1,
      anon_sym_BQUOTE_BQUOTE_BQUOTE,
    ACTIONS(60), 1,
      sym_fence_language,
    ACTIONS(62), 1,
      sym_fence_content,
  [10] = 2,
    ACTIONS(64), 1,
      anon_sym_BQUOTE_BQUOTE_BQUOTE,
    ACTIONS(66), 1,
      sym_fence_content,
  [17] = 1,
    ACTIONS(68), 1,
      ts_builtin_sym_end,
  [21] = 1,
    ACTIONS(70), 1,
      anon_sym_BQUOTE_BQUOTE_BQUOTE,
  [25] = 1,
    ACTIONS(72), 1,
      anon_sym_BQUOTE_BQUOTE_BQUOTE,
};

static const uint32_t ts_small_parse_table_map[] = {
  [SMALL_STATE(9)] = 0,
  [SMALL_STATE(10)] = 10,
  [SMALL_STATE(11)] = 17,
  [SMALL_STATE(12)] = 21,
  [SMALL_STATE(13)] = 25,
};

static const TSParseActionEntry ts_parse_actions[] = {
  [0] = {.entry = {.count = 0, .reusable = false}},
  [1] = {.entry = {.count = 1, .reusable = false}}, RECOVER(),
  [3] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_source_file, 0, 0, 0),
  [5] = {.entry = {.count = 1, .reusable = false}}, SHIFT(2),
  [7] = {.entry = {.count = 1, .reusable = true}}, SHIFT(2),
  [9] = {.entry = {.count = 1, .reusable = true}}, SHIFT(4),
  [11] = {.entry = {.count = 1, .reusable = false}}, SHIFT(4),
  [13] = {.entry = {.count = 1, .reusable = true}}, SHIFT(9),
  [15] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_source_file, 1, 0, 0),
  [17] = {.entry = {.count = 1, .reusable = false}}, SHIFT(3),
  [19] = {.entry = {.count = 1, .reusable = true}}, SHIFT(3),
  [21] = {.entry = {.count = 1, .reusable = true}}, REDUCE(aux_sym_source_file_repeat1, 2, 0, 0),
  [23] = {.entry = {.count = 2, .reusable = false}}, REDUCE(aux_sym_source_file_repeat1, 2, 0, 0), SHIFT_REPEAT(3),
  [26] = {.entry = {.count = 2, .reusable = true}}, REDUCE(aux_sym_source_file_repeat1, 2, 0, 0), SHIFT_REPEAT(3),
  [29] = {.entry = {.count = 2, .reusable = true}}, REDUCE(aux_sym_source_file_repeat1, 2, 0, 0), SHIFT_REPEAT(4),
  [32] = {.entry = {.count = 2, .reusable = false}}, REDUCE(aux_sym_source_file_repeat1, 2, 0, 0), SHIFT_REPEAT(4),
  [35] = {.entry = {.count = 2, .reusable = true}}, REDUCE(aux_sym_source_file_repeat1, 2, 0, 0), SHIFT_REPEAT(9),
  [38] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_operator, 1, 0, 0),
  [40] = {.entry = {.count = 1, .reusable = false}}, REDUCE(sym_operator, 1, 0, 0),
  [42] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_fenced_block, 2, 0, 0),
  [44] = {.entry = {.count = 1, .reusable = false}}, REDUCE(sym_fenced_block, 2, 0, 0),
  [46] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_fenced_block, 3, 0, 1),
  [48] = {.entry = {.count = 1, .reusable = false}}, REDUCE(sym_fenced_block, 3, 0, 1),
  [50] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_fenced_block, 3, 0, 2),
  [52] = {.entry = {.count = 1, .reusable = false}}, REDUCE(sym_fenced_block, 3, 0, 2),
  [54] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_fenced_block, 4, 0, 3),
  [56] = {.entry = {.count = 1, .reusable = false}}, REDUCE(sym_fenced_block, 4, 0, 3),
  [58] = {.entry = {.count = 1, .reusable = false}}, SHIFT(5),
  [60] = {.entry = {.count = 1, .reusable = true}}, SHIFT(10),
  [62] = {.entry = {.count = 1, .reusable = false}}, SHIFT(12),
  [64] = {.entry = {.count = 1, .reusable = false}}, SHIFT(6),
  [66] = {.entry = {.count = 1, .reusable = true}}, SHIFT(13),
  [68] = {.entry = {.count = 1, .reusable = true}},  ACCEPT_INPUT(),
  [70] = {.entry = {.count = 1, .reusable = true}}, SHIFT(7),
  [72] = {.entry = {.count = 1, .reusable = true}}, SHIFT(8),
};

#ifdef __cplusplus
extern "C" {
#endif
#ifdef TREE_SITTER_HIDE_SYMBOLS
#define TS_PUBLIC
#elif defined(_WIN32)
#define TS_PUBLIC __declspec(dllexport)
#else
#define TS_PUBLIC __attribute__((visibility("default")))
#endif

TS_PUBLIC const TSLanguage *tree_sitter_jaiph(void) {
  static const TSLanguage language = {
    .version = LANGUAGE_VERSION,
    .symbol_count = SYMBOL_COUNT,
    .alias_count = ALIAS_COUNT,
    .token_count = TOKEN_COUNT,
    .external_token_count = EXTERNAL_TOKEN_COUNT,
    .state_count = STATE_COUNT,
    .large_state_count = LARGE_STATE_COUNT,
    .production_id_count = PRODUCTION_ID_COUNT,
    .field_count = FIELD_COUNT,
    .max_alias_sequence_length = MAX_ALIAS_SEQUENCE_LENGTH,
    .parse_table = &ts_parse_table[0][0],
    .small_parse_table = ts_small_parse_table,
    .small_parse_table_map = ts_small_parse_table_map,
    .parse_actions = ts_parse_actions,
    .symbol_names = ts_symbol_names,
    .field_names = ts_field_names,
    .field_map_slices = ts_field_map_slices,
    .field_map_entries = ts_field_map_entries,
    .symbol_metadata = ts_symbol_metadata,
    .public_symbol_map = ts_symbol_map,
    .alias_map = ts_non_terminal_alias_map,
    .alias_sequences = &ts_alias_sequences[0][0],
    .lex_modes = ts_lex_modes,
    .lex_fn = ts_lex,
    .keyword_lex_fn = ts_lex_keywords,
    .keyword_capture_token = sym_identifier,
    .primary_state_ids = ts_primary_state_ids,
  };
  return &language;
}
#ifdef __cplusplus
}
#endif
