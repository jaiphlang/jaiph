#include "tree_sitter/parser.h"

#if defined(__GNUC__) || defined(__clang__)
#pragma GCC diagnostic ignored "-Wmissing-field-initializers"
#endif

#define LANGUAGE_VERSION 14
#define STATE_COUNT 19
#define LARGE_STATE_COUNT 12
#define SYMBOL_COUNT 71
#define ALIAS_COUNT 0
#define TOKEN_COUNT 64
#define EXTERNAL_TOKEN_COUNT 0
#define FIELD_COUNT 2
#define MAX_ALIAS_SEQUENCE_LENGTH 4
#define PRODUCTION_ID_COUNT 5

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
  anon_sym_prompt = 12,
  anon_sym_log = 13,
  anon_sym_logerr = 14,
  anon_sym_logwarn = 15,
  anon_sym_fail = 16,
  anon_sym_return = 17,
  anon_sym_send = 18,
  anon_sym_recover = 19,
  anon_sym_catch = 20,
  anon_sym_stdin = 21,
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
  anon_sym_DASH_GT = 46,
  anon_sym_EQ_GT = 47,
  anon_sym_EQ_EQ = 48,
  anon_sym_BANG_EQ = 49,
  anon_sym_EQ_TILDE = 50,
  anon_sym_BANG_TILDE = 51,
  anon_sym_EQ = 52,
  sym_number = 53,
  sym_qualified_identifier = 54,
  sym_regex = 55,
  sym_string = 56,
  sym_triple_string = 57,
  sym__quote_body = 58,
  sym__quote_body_immediate = 59,
  anon_sym_SQUOTE_SQUOTE_SQUOTE = 60,
  anon_sym_SQUOTE_SQUOTE_SQUOTE2 = 61,
  sym_tag_word = 62,
  sym_fence_content = 63,
  sym_source_file = 64,
  sym__token = 65,
  sym_operator = 66,
  sym_quote_script = 67,
  sym_fenced_block = 68,
  sym__script_tag = 69,
  aux_sym_source_file_repeat1 = 70,
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
  [anon_sym_prompt] = "prompt",
  [anon_sym_log] = "log",
  [anon_sym_logerr] = "logerr",
  [anon_sym_logwarn] = "logwarn",
  [anon_sym_fail] = "fail",
  [anon_sym_return] = "return",
  [anon_sym_send] = "send",
  [anon_sym_recover] = "recover",
  [anon_sym_catch] = "catch",
  [anon_sym_stdin] = "stdin",
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
  [sym__quote_body] = "_quote_body",
  [sym__quote_body_immediate] = "_quote_body_immediate",
  [anon_sym_SQUOTE_SQUOTE_SQUOTE] = "'''",
  [anon_sym_SQUOTE_SQUOTE_SQUOTE2] = "'''",
  [sym_tag_word] = "language",
  [sym_fence_content] = "embedded",
  [sym_source_file] = "source_file",
  [sym__token] = "_token",
  [sym_operator] = "operator",
  [sym_quote_script] = "quote_script",
  [sym_fenced_block] = "fenced_block",
  [sym__script_tag] = "_script_tag",
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
  [anon_sym_prompt] = anon_sym_prompt,
  [anon_sym_log] = anon_sym_log,
  [anon_sym_logerr] = anon_sym_logerr,
  [anon_sym_logwarn] = anon_sym_logwarn,
  [anon_sym_fail] = anon_sym_fail,
  [anon_sym_return] = anon_sym_return,
  [anon_sym_send] = anon_sym_send,
  [anon_sym_recover] = anon_sym_recover,
  [anon_sym_catch] = anon_sym_catch,
  [anon_sym_stdin] = anon_sym_stdin,
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
  [sym__quote_body] = sym__quote_body,
  [sym__quote_body_immediate] = sym__quote_body_immediate,
  [anon_sym_SQUOTE_SQUOTE_SQUOTE] = anon_sym_SQUOTE_SQUOTE_SQUOTE,
  [anon_sym_SQUOTE_SQUOTE_SQUOTE2] = anon_sym_SQUOTE_SQUOTE_SQUOTE,
  [sym_tag_word] = sym_tag_word,
  [sym_fence_content] = sym_fence_content,
  [sym_source_file] = sym_source_file,
  [sym__token] = sym__token,
  [sym_operator] = sym_operator,
  [sym_quote_script] = sym_quote_script,
  [sym_fenced_block] = sym_fenced_block,
  [sym__script_tag] = sym__script_tag,
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
  [anon_sym_stdin] = {
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
  [sym__quote_body] = {
    .visible = false,
    .named = true,
  },
  [sym__quote_body_immediate] = {
    .visible = false,
    .named = true,
  },
  [anon_sym_SQUOTE_SQUOTE_SQUOTE] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_SQUOTE_SQUOTE_SQUOTE2] = {
    .visible = true,
    .named = false,
  },
  [sym_tag_word] = {
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
  [sym_quote_script] = {
    .visible = true,
    .named = true,
  },
  [sym_fenced_block] = {
    .visible = true,
    .named = true,
  },
  [sym__script_tag] = {
    .visible = false,
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
  [2] = {.index = 0, .length = 1},
  [3] = {.index = 1, .length = 1},
  [4] = {.index = 2, .length = 2},
};

static const TSFieldMapEntry ts_field_map_entries[] = {
  [0] =
    {field_language, 0},
  [1] =
    {field_body, 1},
  [2] =
    {field_body, 2},
    {field_language, 0},
};

static const TSSymbol ts_alias_sequences[PRODUCTION_ID_COUNT][MAX_ALIAS_SEQUENCE_LENGTH] = {
  [0] = {0},
  [1] = {
    [0] = sym_tag_word,
  },
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
  [14] = 14,
  [15] = 15,
  [16] = 16,
  [17] = 17,
  [18] = 18,
};

static bool ts_lex(TSLexer *lexer, TSStateId state) {
  START_LEXER();
  eof = lexer->eof(lexer);
  switch (state) {
    case 0:
      if (eof) ADVANCE(24);
      ADVANCE_MAP(
        '!', 16,
        '"', 1,
        '#', 33,
        '\'', 7,
        '(', 27,
        ')', 28,
        ',', 32,
        '-', 17,
        '.', 31,
        '/', 20,
        '=', 40,
        '[', 29,
        ']', 30,
        '{', 25,
        '}', 26,
      );
      if (('\t' <= lookahead && lookahead <= '\r') ||
          lookahead == ' ') SKIP(23);
      if (('0' <= lookahead && lookahead <= '9')) ADVANCE(41);
      if (('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(42);
      END_STATE();
    case 1:
      if (lookahead == '"') ADVANCE(46);
      if (lookahead == '\\') ADVANCE(21);
      if (lookahead != 0) ADVANCE(2);
      END_STATE();
    case 2:
      if (lookahead == '"') ADVANCE(45);
      if (lookahead == '\\') ADVANCE(21);
      if (lookahead != 0) ADVANCE(2);
      END_STATE();
    case 3:
      if (lookahead == '"') ADVANCE(47);
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
      if (lookahead == '\'') ADVANCE(7);
      END_STATE();
    case 7:
      if (lookahead == '\'') ADVANCE(51);
      if (lookahead != 0 &&
          lookahead != '\n') ADVANCE(8);
      END_STATE();
    case 8:
      if (lookahead == '\'') ADVANCE(50);
      if (lookahead != 0 &&
          lookahead != '\n') ADVANCE(8);
      END_STATE();
    case 9:
      if (lookahead == '\'') ADVANCE(49);
      if (lookahead != 0 &&
          lookahead != '\n') ADVANCE(11);
      END_STATE();
    case 10:
      if (lookahead == '\'') ADVANCE(52);
      if (lookahead != 0) ADVANCE(56);
      END_STATE();
    case 11:
      if (lookahead == '\'') ADVANCE(48);
      if (lookahead != 0 &&
          lookahead != '\n') ADVANCE(11);
      END_STATE();
    case 12:
      if (lookahead == '\'') ADVANCE(14);
      if (('\t' <= lookahead && lookahead <= '\r') ||
          lookahead == ' ') ADVANCE(55);
      if (lookahead != 0) ADVANCE(56);
      END_STATE();
    case 13:
      if (lookahead == '\'') ADVANCE(22);
      if (lookahead != 0) ADVANCE(56);
      END_STATE();
    case 14:
      if (lookahead == '\'') ADVANCE(10);
      if (lookahead != 0) ADVANCE(56);
      END_STATE();
    case 15:
      if (lookahead == '/') ADVANCE(44);
      if (lookahead != 0 &&
          lookahead != '\n') ADVANCE(15);
      END_STATE();
    case 16:
      if (lookahead == '=') ADVANCE(37);
      if (lookahead == '~') ADVANCE(39);
      END_STATE();
    case 17:
      if (lookahead == '>') ADVANCE(34);
      END_STATE();
    case 18:
      if (('0' <= lookahead && lookahead <= '9')) ADVANCE(54);
      if (('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(43);
      END_STATE();
    case 19:
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(54);
      END_STATE();
    case 20:
      if (lookahead != 0 &&
          lookahead != '\n' &&
          lookahead != '/') ADVANCE(15);
      END_STATE();
    case 21:
      if (lookahead != 0 &&
          lookahead != '\n') ADVANCE(2);
      END_STATE();
    case 22:
      if (lookahead != 0 &&
          lookahead != '\'') ADVANCE(56);
      END_STATE();
    case 23:
      if (eof) ADVANCE(24);
      ADVANCE_MAP(
        '!', 16,
        '"', 1,
        '#', 33,
        '\'', 9,
        '(', 27,
        ')', 28,
        ',', 32,
        '-', 17,
        '.', 31,
        '/', 20,
        '=', 40,
        '[', 29,
        ']', 30,
        '{', 25,
        '}', 26,
      );
      if (('\t' <= lookahead && lookahead <= '\r') ||
          lookahead == ' ') SKIP(23);
      if (('0' <= lookahead && lookahead <= '9')) ADVANCE(41);
      if (('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(42);
      END_STATE();
    case 24:
      ACCEPT_TOKEN(ts_builtin_sym_end);
      END_STATE();
    case 25:
      ACCEPT_TOKEN(anon_sym_LBRACE);
      END_STATE();
    case 26:
      ACCEPT_TOKEN(anon_sym_RBRACE);
      END_STATE();
    case 27:
      ACCEPT_TOKEN(anon_sym_LPAREN);
      END_STATE();
    case 28:
      ACCEPT_TOKEN(anon_sym_RPAREN);
      END_STATE();
    case 29:
      ACCEPT_TOKEN(anon_sym_LBRACK);
      END_STATE();
    case 30:
      ACCEPT_TOKEN(anon_sym_RBRACK);
      END_STATE();
    case 31:
      ACCEPT_TOKEN(anon_sym_DOT);
      END_STATE();
    case 32:
      ACCEPT_TOKEN(anon_sym_COMMA);
      END_STATE();
    case 33:
      ACCEPT_TOKEN(sym_comment);
      if (lookahead != 0 &&
          lookahead != '\n') ADVANCE(33);
      END_STATE();
    case 34:
      ACCEPT_TOKEN(anon_sym_DASH_GT);
      END_STATE();
    case 35:
      ACCEPT_TOKEN(anon_sym_EQ_GT);
      END_STATE();
    case 36:
      ACCEPT_TOKEN(anon_sym_EQ_EQ);
      END_STATE();
    case 37:
      ACCEPT_TOKEN(anon_sym_BANG_EQ);
      END_STATE();
    case 38:
      ACCEPT_TOKEN(anon_sym_EQ_TILDE);
      END_STATE();
    case 39:
      ACCEPT_TOKEN(anon_sym_BANG_TILDE);
      END_STATE();
    case 40:
      ACCEPT_TOKEN(anon_sym_EQ);
      if (lookahead == '=') ADVANCE(36);
      if (lookahead == '>') ADVANCE(35);
      if (lookahead == '~') ADVANCE(38);
      END_STATE();
    case 41:
      ACCEPT_TOKEN(sym_number);
      if (('0' <= lookahead && lookahead <= '9')) ADVANCE(41);
      END_STATE();
    case 42:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == '-') ADVANCE(19);
      if (lookahead == '.') ADVANCE(18);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(42);
      END_STATE();
    case 43:
      ACCEPT_TOKEN(sym_qualified_identifier);
      if (lookahead == '-') ADVANCE(19);
      if (lookahead == '.') ADVANCE(18);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(43);
      END_STATE();
    case 44:
      ACCEPT_TOKEN(sym_regex);
      END_STATE();
    case 45:
      ACCEPT_TOKEN(sym_string);
      END_STATE();
    case 46:
      ACCEPT_TOKEN(sym_string);
      if (lookahead == '"') ADVANCE(5);
      END_STATE();
    case 47:
      ACCEPT_TOKEN(sym_triple_string);
      END_STATE();
    case 48:
      ACCEPT_TOKEN(sym__quote_body);
      END_STATE();
    case 49:
      ACCEPT_TOKEN(sym__quote_body);
      if (lookahead == '\'') ADVANCE(52);
      END_STATE();
    case 50:
      ACCEPT_TOKEN(sym__quote_body_immediate);
      END_STATE();
    case 51:
      ACCEPT_TOKEN(sym__quote_body_immediate);
      if (lookahead == '\'') ADVANCE(53);
      END_STATE();
    case 52:
      ACCEPT_TOKEN(anon_sym_SQUOTE_SQUOTE_SQUOTE);
      END_STATE();
    case 53:
      ACCEPT_TOKEN(anon_sym_SQUOTE_SQUOTE_SQUOTE2);
      END_STATE();
    case 54:
      ACCEPT_TOKEN(sym_tag_word);
      if (lookahead == '-' ||
          lookahead == '.') ADVANCE(19);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(54);
      END_STATE();
    case 55:
      ACCEPT_TOKEN(sym_fence_content);
      if (lookahead == '\'') ADVANCE(14);
      if (('\t' <= lookahead && lookahead <= '\r') ||
          lookahead == ' ') ADVANCE(55);
      if (lookahead != 0) ADVANCE(56);
      END_STATE();
    case 56:
      ACCEPT_TOKEN(sym_fence_content);
      if (lookahead == '\'') ADVANCE(13);
      if (lookahead != 0) ADVANCE(56);
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
      END_STATE();
    case 12:
      if (lookahead == 'c') ADVANCE(34);
      if (lookahead == 'e') ADVANCE(35);
      if (lookahead == 't') ADVANCE(36);
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
      if (lookahead == 'r') ADVANCE(59);
      END_STATE();
    case 35:
      if (lookahead == 'n') ADVANCE(60);
      END_STATE();
    case 36:
      if (lookahead == 'd') ADVANCE(61);
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
      if (lookahead == 'i') ADVANCE(84);
      END_STATE();
    case 60:
      if (lookahead == 'd') ADVANCE(85);
      END_STATE();
    case 61:
      if (lookahead == 'i') ADVANCE(86);
      END_STATE();
    case 62:
      if (lookahead == 't') ADVANCE(87);
      END_STATE();
    case 63:
      if (lookahead == 'e') ADVANCE(88);
      END_STATE();
    case 64:
      ACCEPT_TOKEN(anon_sym_use);
      END_STATE();
    case 65:
      if (lookahead == 'w') ADVANCE(89);
      END_STATE();
    case 66:
      if (lookahead == 'c') ADVANCE(90);
      END_STATE();
    case 67:
      if (lookahead == 'h') ADVANCE(91);
      END_STATE();
    case 68:
      if (lookahead == 'n') ADVANCE(92);
      END_STATE();
    case 69:
      if (lookahead == 'i') ADVANCE(93);
      END_STATE();
    case 70:
      if (lookahead == 't') ADVANCE(94);
      END_STATE();
    case 71:
      ACCEPT_TOKEN(anon_sym_else);
      END_STATE();
    case 72:
      if (lookahead == 'c') ADVANCE(95);
      END_STATE();
    case 73:
      if (lookahead == 'r') ADVANCE(96);
      END_STATE();
    case 74:
      ACCEPT_TOKEN(anon_sym_fail);
      END_STATE();
    case 75:
      if (lookahead == 'e') ADVANCE(97);
      END_STATE();
    case 76:
      if (lookahead == 'r') ADVANCE(98);
      END_STATE();
    case 77:
      if (lookahead == 'r') ADVANCE(99);
      END_STATE();
    case 78:
      if (lookahead == 'a') ADVANCE(100);
      END_STATE();
    case 79:
      if (lookahead == 'h') ADVANCE(101);
      END_STATE();
    case 80:
      ACCEPT_TOKEN(anon_sym_mock);
      END_STATE();
    case 81:
      if (lookahead == 'p') ADVANCE(102);
      END_STATE();
    case 82:
      if (lookahead == 'v') ADVANCE(103);
      END_STATE();
    case 83:
      if (lookahead == 'r') ADVANCE(104);
      END_STATE();
    case 84:
      if (lookahead == 'p') ADVANCE(105);
      END_STATE();
    case 85:
      ACCEPT_TOKEN(anon_sym_send);
      END_STATE();
    case 86:
      if (lookahead == 'n') ADVANCE(106);
      END_STATE();
    case 87:
      ACCEPT_TOKEN(anon_sym_test);
      END_STATE();
    case 88:
      ACCEPT_TOKEN(anon_sym_true);
      END_STATE();
    case 89:
      if (lookahead == '_') ADVANCE(107);
      END_STATE();
    case 90:
      ACCEPT_TOKEN(anon_sym_async);
      END_STATE();
    case 91:
      ACCEPT_TOKEN(anon_sym_catch);
      END_STATE();
    case 92:
      if (lookahead == 'e') ADVANCE(108);
      END_STATE();
    case 93:
      if (lookahead == 'g') ADVANCE(109);
      END_STATE();
    case 94:
      ACCEPT_TOKEN(anon_sym_const);
      END_STATE();
    case 95:
      if (lookahead == 't') ADVANCE(110);
      END_STATE();
    case 96:
      if (lookahead == 't') ADVANCE(111);
      END_STATE();
    case 97:
      ACCEPT_TOKEN(anon_sym_false);
      END_STATE();
    case 98:
      if (lookahead == 't') ADVANCE(112);
      END_STATE();
    case 99:
      if (lookahead == 'r') ADVANCE(113);
      END_STATE();
    case 100:
      if (lookahead == 'r') ADVANCE(114);
      END_STATE();
    case 101:
      ACCEPT_TOKEN(anon_sym_match);
      END_STATE();
    case 102:
      if (lookahead == 't') ADVANCE(115);
      END_STATE();
    case 103:
      if (lookahead == 'e') ADVANCE(116);
      END_STATE();
    case 104:
      if (lookahead == 'n') ADVANCE(117);
      END_STATE();
    case 105:
      if (lookahead == 't') ADVANCE(118);
      END_STATE();
    case 106:
      ACCEPT_TOKEN(anon_sym_stdin);
      END_STATE();
    case 107:
      if (lookahead == 'f') ADVANCE(119);
      END_STATE();
    case 108:
      if (lookahead == 'l') ADVANCE(120);
      END_STATE();
    case 109:
      ACCEPT_TOKEN(anon_sym_config);
      END_STATE();
    case 110:
      if (lookahead == '_') ADVANCE(121);
      END_STATE();
    case 111:
      ACCEPT_TOKEN(anon_sym_export);
      END_STATE();
    case 112:
      ACCEPT_TOKEN(anon_sym_import);
      END_STATE();
    case 113:
      ACCEPT_TOKEN(anon_sym_logerr);
      END_STATE();
    case 114:
      if (lookahead == 'n') ADVANCE(122);
      END_STATE();
    case 115:
      ACCEPT_TOKEN(anon_sym_prompt);
      END_STATE();
    case 116:
      if (lookahead == 'r') ADVANCE(123);
      END_STATE();
    case 117:
      ACCEPT_TOKEN(anon_sym_return);
      if (lookahead == 's') ADVANCE(124);
      END_STATE();
    case 118:
      ACCEPT_TOKEN(anon_sym_script);
      END_STATE();
    case 119:
      if (lookahead == 'a') ADVANCE(125);
      END_STATE();
    case 120:
      ACCEPT_TOKEN(anon_sym_channel);
      END_STATE();
    case 121:
      if (lookahead == 'c') ADVANCE(126);
      if (lookahead == 'e') ADVANCE(127);
      if (lookahead == 'n') ADVANCE(128);
      END_STATE();
    case 122:
      ACCEPT_TOKEN(anon_sym_logwarn);
      END_STATE();
    case 123:
      ACCEPT_TOKEN(anon_sym_recover);
      END_STATE();
    case 124:
      ACCEPT_TOKEN(anon_sym_returns);
      END_STATE();
    case 125:
      if (lookahead == 'i') ADVANCE(129);
      END_STATE();
    case 126:
      if (lookahead == 'o') ADVANCE(130);
      END_STATE();
    case 127:
      if (lookahead == 'q') ADVANCE(131);
      END_STATE();
    case 128:
      if (lookahead == 'o') ADVANCE(132);
      END_STATE();
    case 129:
      if (lookahead == 'l') ADVANCE(133);
      END_STATE();
    case 130:
      if (lookahead == 'n') ADVANCE(134);
      END_STATE();
    case 131:
      if (lookahead == 'u') ADVANCE(135);
      END_STATE();
    case 132:
      if (lookahead == 't') ADVANCE(136);
      END_STATE();
    case 133:
      if (lookahead == 'u') ADVANCE(137);
      END_STATE();
    case 134:
      if (lookahead == 't') ADVANCE(138);
      END_STATE();
    case 135:
      if (lookahead == 'a') ADVANCE(139);
      END_STATE();
    case 136:
      if (lookahead == '_') ADVANCE(140);
      END_STATE();
    case 137:
      if (lookahead == 'r') ADVANCE(141);
      END_STATE();
    case 138:
      if (lookahead == 'a') ADVANCE(142);
      END_STATE();
    case 139:
      if (lookahead == 'l') ADVANCE(143);
      END_STATE();
    case 140:
      if (lookahead == 'c') ADVANCE(144);
      END_STATE();
    case 141:
      if (lookahead == 'e') ADVANCE(145);
      END_STATE();
    case 142:
      if (lookahead == 'i') ADVANCE(146);
      END_STATE();
    case 143:
      ACCEPT_TOKEN(anon_sym_expect_equal);
      END_STATE();
    case 144:
      if (lookahead == 'o') ADVANCE(147);
      END_STATE();
    case 145:
      ACCEPT_TOKEN(anon_sym_allow_failure);
      END_STATE();
    case 146:
      if (lookahead == 'n') ADVANCE(148);
      END_STATE();
    case 147:
      if (lookahead == 'n') ADVANCE(149);
      END_STATE();
    case 148:
      ACCEPT_TOKEN(anon_sym_expect_contain);
      END_STATE();
    case 149:
      if (lookahead == 't') ADVANCE(150);
      END_STATE();
    case 150:
      if (lookahead == 'a') ADVANCE(151);
      END_STATE();
    case 151:
      if (lookahead == 'i') ADVANCE(152);
      END_STATE();
    case 152:
      if (lookahead == 'n') ADVANCE(153);
      END_STATE();
    case 153:
      ACCEPT_TOKEN(anon_sym_expect_not_contain);
      END_STATE();
    default:
      return false;
  }
}

static const TSLexMode ts_lex_modes[STATE_COUNT] = {
  [0] = {.lex_state = 0},
  [1] = {.lex_state = 23},
  [2] = {.lex_state = 23},
  [3] = {.lex_state = 23},
  [4] = {.lex_state = 0},
  [5] = {.lex_state = 23},
  [6] = {.lex_state = 23},
  [7] = {.lex_state = 23},
  [8] = {.lex_state = 23},
  [9] = {.lex_state = 23},
  [10] = {.lex_state = 23},
  [11] = {.lex_state = 23},
  [12] = {.lex_state = 12},
  [13] = {.lex_state = 6},
  [14] = {.lex_state = 6},
  [15] = {.lex_state = 12},
  [16] = {.lex_state = 0},
  [17] = {.lex_state = 23},
  [18] = {.lex_state = 23},
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
    [anon_sym_prompt] = ACTIONS(1),
    [anon_sym_log] = ACTIONS(1),
    [anon_sym_logerr] = ACTIONS(1),
    [anon_sym_logwarn] = ACTIONS(1),
    [anon_sym_fail] = ACTIONS(1),
    [anon_sym_return] = ACTIONS(1),
    [anon_sym_send] = ACTIONS(1),
    [anon_sym_recover] = ACTIONS(1),
    [anon_sym_catch] = ACTIONS(1),
    [anon_sym_stdin] = ACTIONS(1),
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
    [sym__quote_body] = ACTIONS(1),
    [sym__quote_body_immediate] = ACTIONS(1),
    [anon_sym_SQUOTE_SQUOTE_SQUOTE] = ACTIONS(1),
    [anon_sym_SQUOTE_SQUOTE_SQUOTE2] = ACTIONS(1),
    [sym_tag_word] = ACTIONS(1),
  },
  [1] = {
    [sym_source_file] = STATE(16),
    [sym__token] = STATE(2),
    [sym_operator] = STATE(2),
    [sym_quote_script] = STATE(2),
    [sym_fenced_block] = STATE(2),
    [sym__script_tag] = STATE(14),
    [aux_sym_source_file_repeat1] = STATE(2),
    [ts_builtin_sym_end] = ACTIONS(3),
    [sym_identifier] = ACTIONS(5),
    [anon_sym_import] = ACTIONS(7),
    [anon_sym_export] = ACTIONS(7),
    [anon_sym_as] = ACTIONS(7),
    [anon_sym_config] = ACTIONS(7),
    [anon_sym_channel] = ACTIONS(7),
    [anon_sym_script] = ACTIONS(7),
    [anon_sym_def] = ACTIONS(7),
    [anon_sym_test] = ACTIONS(7),
    [anon_sym_use] = ACTIONS(7),
    [anon_sym_const] = ACTIONS(7),
    [anon_sym_prompt] = ACTIONS(7),
    [anon_sym_log] = ACTIONS(7),
    [anon_sym_logerr] = ACTIONS(7),
    [anon_sym_logwarn] = ACTIONS(7),
    [anon_sym_fail] = ACTIONS(7),
    [anon_sym_return] = ACTIONS(7),
    [anon_sym_send] = ACTIONS(7),
    [anon_sym_recover] = ACTIONS(7),
    [anon_sym_catch] = ACTIONS(7),
    [anon_sym_stdin] = ACTIONS(7),
    [anon_sym_if] = ACTIONS(7),
    [anon_sym_else] = ACTIONS(7),
    [anon_sym_for] = ACTIONS(7),
    [anon_sym_in] = ACTIONS(7),
    [anon_sym_match] = ACTIONS(7),
    [anon_sym_async] = ACTIONS(7),
    [anon_sym_returns] = ACTIONS(7),
    [anon_sym_not] = ACTIONS(7),
    [anon_sym_mock] = ACTIONS(7),
    [anon_sym_allow_failure] = ACTIONS(7),
    [anon_sym_expect_contain] = ACTIONS(7),
    [anon_sym_expect_not_contain] = ACTIONS(7),
    [anon_sym_expect_equal] = ACTIONS(7),
    [anon_sym_true] = ACTIONS(7),
    [anon_sym_false] = ACTIONS(7),
    [anon_sym_LBRACE] = ACTIONS(9),
    [anon_sym_RBRACE] = ACTIONS(9),
    [anon_sym_LPAREN] = ACTIONS(9),
    [anon_sym_RPAREN] = ACTIONS(9),
    [anon_sym_LBRACK] = ACTIONS(9),
    [anon_sym_RBRACK] = ACTIONS(9),
    [anon_sym_DOT] = ACTIONS(9),
    [anon_sym_COMMA] = ACTIONS(9),
    [sym_comment] = ACTIONS(9),
    [anon_sym_DASH_GT] = ACTIONS(11),
    [anon_sym_EQ_GT] = ACTIONS(11),
    [anon_sym_EQ_EQ] = ACTIONS(11),
    [anon_sym_BANG_EQ] = ACTIONS(11),
    [anon_sym_EQ_TILDE] = ACTIONS(11),
    [anon_sym_BANG_TILDE] = ACTIONS(11),
    [anon_sym_EQ] = ACTIONS(13),
    [sym_number] = ACTIONS(9),
    [sym_qualified_identifier] = ACTIONS(5),
    [sym_regex] = ACTIONS(9),
    [sym_string] = ACTIONS(7),
    [sym_triple_string] = ACTIONS(9),
    [sym__quote_body] = ACTIONS(15),
    [anon_sym_SQUOTE_SQUOTE_SQUOTE] = ACTIONS(17),
    [sym_tag_word] = ACTIONS(19),
  },
  [2] = {
    [sym__token] = STATE(3),
    [sym_operator] = STATE(3),
    [sym_quote_script] = STATE(3),
    [sym_fenced_block] = STATE(3),
    [sym__script_tag] = STATE(14),
    [aux_sym_source_file_repeat1] = STATE(3),
    [ts_builtin_sym_end] = ACTIONS(21),
    [sym_identifier] = ACTIONS(5),
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
    [anon_sym_prompt] = ACTIONS(23),
    [anon_sym_log] = ACTIONS(23),
    [anon_sym_logerr] = ACTIONS(23),
    [anon_sym_logwarn] = ACTIONS(23),
    [anon_sym_fail] = ACTIONS(23),
    [anon_sym_return] = ACTIONS(23),
    [anon_sym_send] = ACTIONS(23),
    [anon_sym_recover] = ACTIONS(23),
    [anon_sym_catch] = ACTIONS(23),
    [anon_sym_stdin] = ACTIONS(23),
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
    [anon_sym_LBRACE] = ACTIONS(25),
    [anon_sym_RBRACE] = ACTIONS(25),
    [anon_sym_LPAREN] = ACTIONS(25),
    [anon_sym_RPAREN] = ACTIONS(25),
    [anon_sym_LBRACK] = ACTIONS(25),
    [anon_sym_RBRACK] = ACTIONS(25),
    [anon_sym_DOT] = ACTIONS(25),
    [anon_sym_COMMA] = ACTIONS(25),
    [sym_comment] = ACTIONS(25),
    [anon_sym_DASH_GT] = ACTIONS(11),
    [anon_sym_EQ_GT] = ACTIONS(11),
    [anon_sym_EQ_EQ] = ACTIONS(11),
    [anon_sym_BANG_EQ] = ACTIONS(11),
    [anon_sym_EQ_TILDE] = ACTIONS(11),
    [anon_sym_BANG_TILDE] = ACTIONS(11),
    [anon_sym_EQ] = ACTIONS(13),
    [sym_number] = ACTIONS(25),
    [sym_qualified_identifier] = ACTIONS(5),
    [sym_regex] = ACTIONS(25),
    [sym_string] = ACTIONS(23),
    [sym_triple_string] = ACTIONS(25),
    [sym__quote_body] = ACTIONS(15),
    [anon_sym_SQUOTE_SQUOTE_SQUOTE] = ACTIONS(17),
    [sym_tag_word] = ACTIONS(19),
  },
  [3] = {
    [sym__token] = STATE(3),
    [sym_operator] = STATE(3),
    [sym_quote_script] = STATE(3),
    [sym_fenced_block] = STATE(3),
    [sym__script_tag] = STATE(14),
    [aux_sym_source_file_repeat1] = STATE(3),
    [ts_builtin_sym_end] = ACTIONS(27),
    [sym_identifier] = ACTIONS(29),
    [anon_sym_import] = ACTIONS(32),
    [anon_sym_export] = ACTIONS(32),
    [anon_sym_as] = ACTIONS(32),
    [anon_sym_config] = ACTIONS(32),
    [anon_sym_channel] = ACTIONS(32),
    [anon_sym_script] = ACTIONS(32),
    [anon_sym_def] = ACTIONS(32),
    [anon_sym_test] = ACTIONS(32),
    [anon_sym_use] = ACTIONS(32),
    [anon_sym_const] = ACTIONS(32),
    [anon_sym_prompt] = ACTIONS(32),
    [anon_sym_log] = ACTIONS(32),
    [anon_sym_logerr] = ACTIONS(32),
    [anon_sym_logwarn] = ACTIONS(32),
    [anon_sym_fail] = ACTIONS(32),
    [anon_sym_return] = ACTIONS(32),
    [anon_sym_send] = ACTIONS(32),
    [anon_sym_recover] = ACTIONS(32),
    [anon_sym_catch] = ACTIONS(32),
    [anon_sym_stdin] = ACTIONS(32),
    [anon_sym_if] = ACTIONS(32),
    [anon_sym_else] = ACTIONS(32),
    [anon_sym_for] = ACTIONS(32),
    [anon_sym_in] = ACTIONS(32),
    [anon_sym_match] = ACTIONS(32),
    [anon_sym_async] = ACTIONS(32),
    [anon_sym_returns] = ACTIONS(32),
    [anon_sym_not] = ACTIONS(32),
    [anon_sym_mock] = ACTIONS(32),
    [anon_sym_allow_failure] = ACTIONS(32),
    [anon_sym_expect_contain] = ACTIONS(32),
    [anon_sym_expect_not_contain] = ACTIONS(32),
    [anon_sym_expect_equal] = ACTIONS(32),
    [anon_sym_true] = ACTIONS(32),
    [anon_sym_false] = ACTIONS(32),
    [anon_sym_LBRACE] = ACTIONS(35),
    [anon_sym_RBRACE] = ACTIONS(35),
    [anon_sym_LPAREN] = ACTIONS(35),
    [anon_sym_RPAREN] = ACTIONS(35),
    [anon_sym_LBRACK] = ACTIONS(35),
    [anon_sym_RBRACK] = ACTIONS(35),
    [anon_sym_DOT] = ACTIONS(35),
    [anon_sym_COMMA] = ACTIONS(35),
    [sym_comment] = ACTIONS(35),
    [anon_sym_DASH_GT] = ACTIONS(38),
    [anon_sym_EQ_GT] = ACTIONS(38),
    [anon_sym_EQ_EQ] = ACTIONS(38),
    [anon_sym_BANG_EQ] = ACTIONS(38),
    [anon_sym_EQ_TILDE] = ACTIONS(38),
    [anon_sym_BANG_TILDE] = ACTIONS(38),
    [anon_sym_EQ] = ACTIONS(41),
    [sym_number] = ACTIONS(35),
    [sym_qualified_identifier] = ACTIONS(29),
    [sym_regex] = ACTIONS(35),
    [sym_string] = ACTIONS(32),
    [sym_triple_string] = ACTIONS(35),
    [sym__quote_body] = ACTIONS(44),
    [anon_sym_SQUOTE_SQUOTE_SQUOTE] = ACTIONS(47),
    [sym_tag_word] = ACTIONS(50),
  },
  [4] = {
    [ts_builtin_sym_end] = ACTIONS(53),
    [sym_identifier] = ACTIONS(55),
    [anon_sym_import] = ACTIONS(55),
    [anon_sym_export] = ACTIONS(55),
    [anon_sym_as] = ACTIONS(55),
    [anon_sym_config] = ACTIONS(55),
    [anon_sym_channel] = ACTIONS(55),
    [anon_sym_script] = ACTIONS(55),
    [anon_sym_def] = ACTIONS(55),
    [anon_sym_test] = ACTIONS(55),
    [anon_sym_use] = ACTIONS(55),
    [anon_sym_const] = ACTIONS(55),
    [anon_sym_prompt] = ACTIONS(55),
    [anon_sym_log] = ACTIONS(55),
    [anon_sym_logerr] = ACTIONS(55),
    [anon_sym_logwarn] = ACTIONS(55),
    [anon_sym_fail] = ACTIONS(55),
    [anon_sym_return] = ACTIONS(55),
    [anon_sym_send] = ACTIONS(55),
    [anon_sym_recover] = ACTIONS(55),
    [anon_sym_catch] = ACTIONS(55),
    [anon_sym_stdin] = ACTIONS(55),
    [anon_sym_if] = ACTIONS(55),
    [anon_sym_else] = ACTIONS(55),
    [anon_sym_for] = ACTIONS(55),
    [anon_sym_in] = ACTIONS(55),
    [anon_sym_match] = ACTIONS(55),
    [anon_sym_async] = ACTIONS(55),
    [anon_sym_returns] = ACTIONS(55),
    [anon_sym_not] = ACTIONS(55),
    [anon_sym_mock] = ACTIONS(55),
    [anon_sym_allow_failure] = ACTIONS(55),
    [anon_sym_expect_contain] = ACTIONS(55),
    [anon_sym_expect_not_contain] = ACTIONS(55),
    [anon_sym_expect_equal] = ACTIONS(55),
    [anon_sym_true] = ACTIONS(55),
    [anon_sym_false] = ACTIONS(55),
    [anon_sym_LBRACE] = ACTIONS(53),
    [anon_sym_RBRACE] = ACTIONS(53),
    [anon_sym_LPAREN] = ACTIONS(53),
    [anon_sym_RPAREN] = ACTIONS(53),
    [anon_sym_LBRACK] = ACTIONS(53),
    [anon_sym_RBRACK] = ACTIONS(53),
    [anon_sym_DOT] = ACTIONS(53),
    [anon_sym_COMMA] = ACTIONS(53),
    [sym_comment] = ACTIONS(53),
    [anon_sym_DASH_GT] = ACTIONS(53),
    [anon_sym_EQ_GT] = ACTIONS(53),
    [anon_sym_EQ_EQ] = ACTIONS(53),
    [anon_sym_BANG_EQ] = ACTIONS(53),
    [anon_sym_EQ_TILDE] = ACTIONS(53),
    [anon_sym_BANG_TILDE] = ACTIONS(53),
    [anon_sym_EQ] = ACTIONS(55),
    [sym_number] = ACTIONS(53),
    [sym_qualified_identifier] = ACTIONS(55),
    [sym_regex] = ACTIONS(53),
    [sym_string] = ACTIONS(55),
    [sym_triple_string] = ACTIONS(53),
    [sym__quote_body] = ACTIONS(55),
    [sym__quote_body_immediate] = ACTIONS(57),
    [anon_sym_SQUOTE_SQUOTE_SQUOTE] = ACTIONS(55),
    [anon_sym_SQUOTE_SQUOTE_SQUOTE2] = ACTIONS(59),
    [sym_tag_word] = ACTIONS(53),
  },
  [5] = {
    [ts_builtin_sym_end] = ACTIONS(61),
    [sym_identifier] = ACTIONS(63),
    [anon_sym_import] = ACTIONS(63),
    [anon_sym_export] = ACTIONS(63),
    [anon_sym_as] = ACTIONS(63),
    [anon_sym_config] = ACTIONS(63),
    [anon_sym_channel] = ACTIONS(63),
    [anon_sym_script] = ACTIONS(63),
    [anon_sym_def] = ACTIONS(63),
    [anon_sym_test] = ACTIONS(63),
    [anon_sym_use] = ACTIONS(63),
    [anon_sym_const] = ACTIONS(63),
    [anon_sym_prompt] = ACTIONS(63),
    [anon_sym_log] = ACTIONS(63),
    [anon_sym_logerr] = ACTIONS(63),
    [anon_sym_logwarn] = ACTIONS(63),
    [anon_sym_fail] = ACTIONS(63),
    [anon_sym_return] = ACTIONS(63),
    [anon_sym_send] = ACTIONS(63),
    [anon_sym_recover] = ACTIONS(63),
    [anon_sym_catch] = ACTIONS(63),
    [anon_sym_stdin] = ACTIONS(63),
    [anon_sym_if] = ACTIONS(63),
    [anon_sym_else] = ACTIONS(63),
    [anon_sym_for] = ACTIONS(63),
    [anon_sym_in] = ACTIONS(63),
    [anon_sym_match] = ACTIONS(63),
    [anon_sym_async] = ACTIONS(63),
    [anon_sym_returns] = ACTIONS(63),
    [anon_sym_not] = ACTIONS(63),
    [anon_sym_mock] = ACTIONS(63),
    [anon_sym_allow_failure] = ACTIONS(63),
    [anon_sym_expect_contain] = ACTIONS(63),
    [anon_sym_expect_not_contain] = ACTIONS(63),
    [anon_sym_expect_equal] = ACTIONS(63),
    [anon_sym_true] = ACTIONS(63),
    [anon_sym_false] = ACTIONS(63),
    [anon_sym_LBRACE] = ACTIONS(61),
    [anon_sym_RBRACE] = ACTIONS(61),
    [anon_sym_LPAREN] = ACTIONS(61),
    [anon_sym_RPAREN] = ACTIONS(61),
    [anon_sym_LBRACK] = ACTIONS(61),
    [anon_sym_RBRACK] = ACTIONS(61),
    [anon_sym_DOT] = ACTIONS(61),
    [anon_sym_COMMA] = ACTIONS(61),
    [sym_comment] = ACTIONS(61),
    [anon_sym_DASH_GT] = ACTIONS(61),
    [anon_sym_EQ_GT] = ACTIONS(61),
    [anon_sym_EQ_EQ] = ACTIONS(61),
    [anon_sym_BANG_EQ] = ACTIONS(61),
    [anon_sym_EQ_TILDE] = ACTIONS(61),
    [anon_sym_BANG_TILDE] = ACTIONS(61),
    [anon_sym_EQ] = ACTIONS(63),
    [sym_number] = ACTIONS(61),
    [sym_qualified_identifier] = ACTIONS(63),
    [sym_regex] = ACTIONS(61),
    [sym_string] = ACTIONS(63),
    [sym_triple_string] = ACTIONS(61),
    [sym__quote_body] = ACTIONS(63),
    [anon_sym_SQUOTE_SQUOTE_SQUOTE] = ACTIONS(61),
    [sym_tag_word] = ACTIONS(61),
  },
  [6] = {
    [ts_builtin_sym_end] = ACTIONS(65),
    [sym_identifier] = ACTIONS(67),
    [anon_sym_import] = ACTIONS(67),
    [anon_sym_export] = ACTIONS(67),
    [anon_sym_as] = ACTIONS(67),
    [anon_sym_config] = ACTIONS(67),
    [anon_sym_channel] = ACTIONS(67),
    [anon_sym_script] = ACTIONS(67),
    [anon_sym_def] = ACTIONS(67),
    [anon_sym_test] = ACTIONS(67),
    [anon_sym_use] = ACTIONS(67),
    [anon_sym_const] = ACTIONS(67),
    [anon_sym_prompt] = ACTIONS(67),
    [anon_sym_log] = ACTIONS(67),
    [anon_sym_logerr] = ACTIONS(67),
    [anon_sym_logwarn] = ACTIONS(67),
    [anon_sym_fail] = ACTIONS(67),
    [anon_sym_return] = ACTIONS(67),
    [anon_sym_send] = ACTIONS(67),
    [anon_sym_recover] = ACTIONS(67),
    [anon_sym_catch] = ACTIONS(67),
    [anon_sym_stdin] = ACTIONS(67),
    [anon_sym_if] = ACTIONS(67),
    [anon_sym_else] = ACTIONS(67),
    [anon_sym_for] = ACTIONS(67),
    [anon_sym_in] = ACTIONS(67),
    [anon_sym_match] = ACTIONS(67),
    [anon_sym_async] = ACTIONS(67),
    [anon_sym_returns] = ACTIONS(67),
    [anon_sym_not] = ACTIONS(67),
    [anon_sym_mock] = ACTIONS(67),
    [anon_sym_allow_failure] = ACTIONS(67),
    [anon_sym_expect_contain] = ACTIONS(67),
    [anon_sym_expect_not_contain] = ACTIONS(67),
    [anon_sym_expect_equal] = ACTIONS(67),
    [anon_sym_true] = ACTIONS(67),
    [anon_sym_false] = ACTIONS(67),
    [anon_sym_LBRACE] = ACTIONS(65),
    [anon_sym_RBRACE] = ACTIONS(65),
    [anon_sym_LPAREN] = ACTIONS(65),
    [anon_sym_RPAREN] = ACTIONS(65),
    [anon_sym_LBRACK] = ACTIONS(65),
    [anon_sym_RBRACK] = ACTIONS(65),
    [anon_sym_DOT] = ACTIONS(65),
    [anon_sym_COMMA] = ACTIONS(65),
    [sym_comment] = ACTIONS(65),
    [anon_sym_DASH_GT] = ACTIONS(65),
    [anon_sym_EQ_GT] = ACTIONS(65),
    [anon_sym_EQ_EQ] = ACTIONS(65),
    [anon_sym_BANG_EQ] = ACTIONS(65),
    [anon_sym_EQ_TILDE] = ACTIONS(65),
    [anon_sym_BANG_TILDE] = ACTIONS(65),
    [anon_sym_EQ] = ACTIONS(67),
    [sym_number] = ACTIONS(65),
    [sym_qualified_identifier] = ACTIONS(67),
    [sym_regex] = ACTIONS(65),
    [sym_string] = ACTIONS(67),
    [sym_triple_string] = ACTIONS(65),
    [sym__quote_body] = ACTIONS(67),
    [anon_sym_SQUOTE_SQUOTE_SQUOTE] = ACTIONS(65),
    [sym_tag_word] = ACTIONS(65),
  },
  [7] = {
    [ts_builtin_sym_end] = ACTIONS(69),
    [sym_identifier] = ACTIONS(71),
    [anon_sym_import] = ACTIONS(71),
    [anon_sym_export] = ACTIONS(71),
    [anon_sym_as] = ACTIONS(71),
    [anon_sym_config] = ACTIONS(71),
    [anon_sym_channel] = ACTIONS(71),
    [anon_sym_script] = ACTIONS(71),
    [anon_sym_def] = ACTIONS(71),
    [anon_sym_test] = ACTIONS(71),
    [anon_sym_use] = ACTIONS(71),
    [anon_sym_const] = ACTIONS(71),
    [anon_sym_prompt] = ACTIONS(71),
    [anon_sym_log] = ACTIONS(71),
    [anon_sym_logerr] = ACTIONS(71),
    [anon_sym_logwarn] = ACTIONS(71),
    [anon_sym_fail] = ACTIONS(71),
    [anon_sym_return] = ACTIONS(71),
    [anon_sym_send] = ACTIONS(71),
    [anon_sym_recover] = ACTIONS(71),
    [anon_sym_catch] = ACTIONS(71),
    [anon_sym_stdin] = ACTIONS(71),
    [anon_sym_if] = ACTIONS(71),
    [anon_sym_else] = ACTIONS(71),
    [anon_sym_for] = ACTIONS(71),
    [anon_sym_in] = ACTIONS(71),
    [anon_sym_match] = ACTIONS(71),
    [anon_sym_async] = ACTIONS(71),
    [anon_sym_returns] = ACTIONS(71),
    [anon_sym_not] = ACTIONS(71),
    [anon_sym_mock] = ACTIONS(71),
    [anon_sym_allow_failure] = ACTIONS(71),
    [anon_sym_expect_contain] = ACTIONS(71),
    [anon_sym_expect_not_contain] = ACTIONS(71),
    [anon_sym_expect_equal] = ACTIONS(71),
    [anon_sym_true] = ACTIONS(71),
    [anon_sym_false] = ACTIONS(71),
    [anon_sym_LBRACE] = ACTIONS(69),
    [anon_sym_RBRACE] = ACTIONS(69),
    [anon_sym_LPAREN] = ACTIONS(69),
    [anon_sym_RPAREN] = ACTIONS(69),
    [anon_sym_LBRACK] = ACTIONS(69),
    [anon_sym_RBRACK] = ACTIONS(69),
    [anon_sym_DOT] = ACTIONS(69),
    [anon_sym_COMMA] = ACTIONS(69),
    [sym_comment] = ACTIONS(69),
    [anon_sym_DASH_GT] = ACTIONS(69),
    [anon_sym_EQ_GT] = ACTIONS(69),
    [anon_sym_EQ_EQ] = ACTIONS(69),
    [anon_sym_BANG_EQ] = ACTIONS(69),
    [anon_sym_EQ_TILDE] = ACTIONS(69),
    [anon_sym_BANG_TILDE] = ACTIONS(69),
    [anon_sym_EQ] = ACTIONS(71),
    [sym_number] = ACTIONS(69),
    [sym_qualified_identifier] = ACTIONS(71),
    [sym_regex] = ACTIONS(69),
    [sym_string] = ACTIONS(71),
    [sym_triple_string] = ACTIONS(69),
    [sym__quote_body] = ACTIONS(71),
    [anon_sym_SQUOTE_SQUOTE_SQUOTE] = ACTIONS(69),
    [sym_tag_word] = ACTIONS(69),
  },
  [8] = {
    [ts_builtin_sym_end] = ACTIONS(73),
    [sym_identifier] = ACTIONS(75),
    [anon_sym_import] = ACTIONS(75),
    [anon_sym_export] = ACTIONS(75),
    [anon_sym_as] = ACTIONS(75),
    [anon_sym_config] = ACTIONS(75),
    [anon_sym_channel] = ACTIONS(75),
    [anon_sym_script] = ACTIONS(75),
    [anon_sym_def] = ACTIONS(75),
    [anon_sym_test] = ACTIONS(75),
    [anon_sym_use] = ACTIONS(75),
    [anon_sym_const] = ACTIONS(75),
    [anon_sym_prompt] = ACTIONS(75),
    [anon_sym_log] = ACTIONS(75),
    [anon_sym_logerr] = ACTIONS(75),
    [anon_sym_logwarn] = ACTIONS(75),
    [anon_sym_fail] = ACTIONS(75),
    [anon_sym_return] = ACTIONS(75),
    [anon_sym_send] = ACTIONS(75),
    [anon_sym_recover] = ACTIONS(75),
    [anon_sym_catch] = ACTIONS(75),
    [anon_sym_stdin] = ACTIONS(75),
    [anon_sym_if] = ACTIONS(75),
    [anon_sym_else] = ACTIONS(75),
    [anon_sym_for] = ACTIONS(75),
    [anon_sym_in] = ACTIONS(75),
    [anon_sym_match] = ACTIONS(75),
    [anon_sym_async] = ACTIONS(75),
    [anon_sym_returns] = ACTIONS(75),
    [anon_sym_not] = ACTIONS(75),
    [anon_sym_mock] = ACTIONS(75),
    [anon_sym_allow_failure] = ACTIONS(75),
    [anon_sym_expect_contain] = ACTIONS(75),
    [anon_sym_expect_not_contain] = ACTIONS(75),
    [anon_sym_expect_equal] = ACTIONS(75),
    [anon_sym_true] = ACTIONS(75),
    [anon_sym_false] = ACTIONS(75),
    [anon_sym_LBRACE] = ACTIONS(73),
    [anon_sym_RBRACE] = ACTIONS(73),
    [anon_sym_LPAREN] = ACTIONS(73),
    [anon_sym_RPAREN] = ACTIONS(73),
    [anon_sym_LBRACK] = ACTIONS(73),
    [anon_sym_RBRACK] = ACTIONS(73),
    [anon_sym_DOT] = ACTIONS(73),
    [anon_sym_COMMA] = ACTIONS(73),
    [sym_comment] = ACTIONS(73),
    [anon_sym_DASH_GT] = ACTIONS(73),
    [anon_sym_EQ_GT] = ACTIONS(73),
    [anon_sym_EQ_EQ] = ACTIONS(73),
    [anon_sym_BANG_EQ] = ACTIONS(73),
    [anon_sym_EQ_TILDE] = ACTIONS(73),
    [anon_sym_BANG_TILDE] = ACTIONS(73),
    [anon_sym_EQ] = ACTIONS(75),
    [sym_number] = ACTIONS(73),
    [sym_qualified_identifier] = ACTIONS(75),
    [sym_regex] = ACTIONS(73),
    [sym_string] = ACTIONS(75),
    [sym_triple_string] = ACTIONS(73),
    [sym__quote_body] = ACTIONS(75),
    [anon_sym_SQUOTE_SQUOTE_SQUOTE] = ACTIONS(73),
    [sym_tag_word] = ACTIONS(73),
  },
  [9] = {
    [ts_builtin_sym_end] = ACTIONS(77),
    [sym_identifier] = ACTIONS(79),
    [anon_sym_import] = ACTIONS(79),
    [anon_sym_export] = ACTIONS(79),
    [anon_sym_as] = ACTIONS(79),
    [anon_sym_config] = ACTIONS(79),
    [anon_sym_channel] = ACTIONS(79),
    [anon_sym_script] = ACTIONS(79),
    [anon_sym_def] = ACTIONS(79),
    [anon_sym_test] = ACTIONS(79),
    [anon_sym_use] = ACTIONS(79),
    [anon_sym_const] = ACTIONS(79),
    [anon_sym_prompt] = ACTIONS(79),
    [anon_sym_log] = ACTIONS(79),
    [anon_sym_logerr] = ACTIONS(79),
    [anon_sym_logwarn] = ACTIONS(79),
    [anon_sym_fail] = ACTIONS(79),
    [anon_sym_return] = ACTIONS(79),
    [anon_sym_send] = ACTIONS(79),
    [anon_sym_recover] = ACTIONS(79),
    [anon_sym_catch] = ACTIONS(79),
    [anon_sym_stdin] = ACTIONS(79),
    [anon_sym_if] = ACTIONS(79),
    [anon_sym_else] = ACTIONS(79),
    [anon_sym_for] = ACTIONS(79),
    [anon_sym_in] = ACTIONS(79),
    [anon_sym_match] = ACTIONS(79),
    [anon_sym_async] = ACTIONS(79),
    [anon_sym_returns] = ACTIONS(79),
    [anon_sym_not] = ACTIONS(79),
    [anon_sym_mock] = ACTIONS(79),
    [anon_sym_allow_failure] = ACTIONS(79),
    [anon_sym_expect_contain] = ACTIONS(79),
    [anon_sym_expect_not_contain] = ACTIONS(79),
    [anon_sym_expect_equal] = ACTIONS(79),
    [anon_sym_true] = ACTIONS(79),
    [anon_sym_false] = ACTIONS(79),
    [anon_sym_LBRACE] = ACTIONS(77),
    [anon_sym_RBRACE] = ACTIONS(77),
    [anon_sym_LPAREN] = ACTIONS(77),
    [anon_sym_RPAREN] = ACTIONS(77),
    [anon_sym_LBRACK] = ACTIONS(77),
    [anon_sym_RBRACK] = ACTIONS(77),
    [anon_sym_DOT] = ACTIONS(77),
    [anon_sym_COMMA] = ACTIONS(77),
    [sym_comment] = ACTIONS(77),
    [anon_sym_DASH_GT] = ACTIONS(77),
    [anon_sym_EQ_GT] = ACTIONS(77),
    [anon_sym_EQ_EQ] = ACTIONS(77),
    [anon_sym_BANG_EQ] = ACTIONS(77),
    [anon_sym_EQ_TILDE] = ACTIONS(77),
    [anon_sym_BANG_TILDE] = ACTIONS(77),
    [anon_sym_EQ] = ACTIONS(79),
    [sym_number] = ACTIONS(77),
    [sym_qualified_identifier] = ACTIONS(79),
    [sym_regex] = ACTIONS(77),
    [sym_string] = ACTIONS(79),
    [sym_triple_string] = ACTIONS(77),
    [sym__quote_body] = ACTIONS(79),
    [anon_sym_SQUOTE_SQUOTE_SQUOTE] = ACTIONS(77),
    [sym_tag_word] = ACTIONS(77),
  },
  [10] = {
    [ts_builtin_sym_end] = ACTIONS(81),
    [sym_identifier] = ACTIONS(83),
    [anon_sym_import] = ACTIONS(83),
    [anon_sym_export] = ACTIONS(83),
    [anon_sym_as] = ACTIONS(83),
    [anon_sym_config] = ACTIONS(83),
    [anon_sym_channel] = ACTIONS(83),
    [anon_sym_script] = ACTIONS(83),
    [anon_sym_def] = ACTIONS(83),
    [anon_sym_test] = ACTIONS(83),
    [anon_sym_use] = ACTIONS(83),
    [anon_sym_const] = ACTIONS(83),
    [anon_sym_prompt] = ACTIONS(83),
    [anon_sym_log] = ACTIONS(83),
    [anon_sym_logerr] = ACTIONS(83),
    [anon_sym_logwarn] = ACTIONS(83),
    [anon_sym_fail] = ACTIONS(83),
    [anon_sym_return] = ACTIONS(83),
    [anon_sym_send] = ACTIONS(83),
    [anon_sym_recover] = ACTIONS(83),
    [anon_sym_catch] = ACTIONS(83),
    [anon_sym_stdin] = ACTIONS(83),
    [anon_sym_if] = ACTIONS(83),
    [anon_sym_else] = ACTIONS(83),
    [anon_sym_for] = ACTIONS(83),
    [anon_sym_in] = ACTIONS(83),
    [anon_sym_match] = ACTIONS(83),
    [anon_sym_async] = ACTIONS(83),
    [anon_sym_returns] = ACTIONS(83),
    [anon_sym_not] = ACTIONS(83),
    [anon_sym_mock] = ACTIONS(83),
    [anon_sym_allow_failure] = ACTIONS(83),
    [anon_sym_expect_contain] = ACTIONS(83),
    [anon_sym_expect_not_contain] = ACTIONS(83),
    [anon_sym_expect_equal] = ACTIONS(83),
    [anon_sym_true] = ACTIONS(83),
    [anon_sym_false] = ACTIONS(83),
    [anon_sym_LBRACE] = ACTIONS(81),
    [anon_sym_RBRACE] = ACTIONS(81),
    [anon_sym_LPAREN] = ACTIONS(81),
    [anon_sym_RPAREN] = ACTIONS(81),
    [anon_sym_LBRACK] = ACTIONS(81),
    [anon_sym_RBRACK] = ACTIONS(81),
    [anon_sym_DOT] = ACTIONS(81),
    [anon_sym_COMMA] = ACTIONS(81),
    [sym_comment] = ACTIONS(81),
    [anon_sym_DASH_GT] = ACTIONS(81),
    [anon_sym_EQ_GT] = ACTIONS(81),
    [anon_sym_EQ_EQ] = ACTIONS(81),
    [anon_sym_BANG_EQ] = ACTIONS(81),
    [anon_sym_EQ_TILDE] = ACTIONS(81),
    [anon_sym_BANG_TILDE] = ACTIONS(81),
    [anon_sym_EQ] = ACTIONS(83),
    [sym_number] = ACTIONS(81),
    [sym_qualified_identifier] = ACTIONS(83),
    [sym_regex] = ACTIONS(81),
    [sym_string] = ACTIONS(83),
    [sym_triple_string] = ACTIONS(81),
    [sym__quote_body] = ACTIONS(83),
    [anon_sym_SQUOTE_SQUOTE_SQUOTE] = ACTIONS(81),
    [sym_tag_word] = ACTIONS(81),
  },
  [11] = {
    [ts_builtin_sym_end] = ACTIONS(85),
    [sym_identifier] = ACTIONS(87),
    [anon_sym_import] = ACTIONS(87),
    [anon_sym_export] = ACTIONS(87),
    [anon_sym_as] = ACTIONS(87),
    [anon_sym_config] = ACTIONS(87),
    [anon_sym_channel] = ACTIONS(87),
    [anon_sym_script] = ACTIONS(87),
    [anon_sym_def] = ACTIONS(87),
    [anon_sym_test] = ACTIONS(87),
    [anon_sym_use] = ACTIONS(87),
    [anon_sym_const] = ACTIONS(87),
    [anon_sym_prompt] = ACTIONS(87),
    [anon_sym_log] = ACTIONS(87),
    [anon_sym_logerr] = ACTIONS(87),
    [anon_sym_logwarn] = ACTIONS(87),
    [anon_sym_fail] = ACTIONS(87),
    [anon_sym_return] = ACTIONS(87),
    [anon_sym_send] = ACTIONS(87),
    [anon_sym_recover] = ACTIONS(87),
    [anon_sym_catch] = ACTIONS(87),
    [anon_sym_stdin] = ACTIONS(87),
    [anon_sym_if] = ACTIONS(87),
    [anon_sym_else] = ACTIONS(87),
    [anon_sym_for] = ACTIONS(87),
    [anon_sym_in] = ACTIONS(87),
    [anon_sym_match] = ACTIONS(87),
    [anon_sym_async] = ACTIONS(87),
    [anon_sym_returns] = ACTIONS(87),
    [anon_sym_not] = ACTIONS(87),
    [anon_sym_mock] = ACTIONS(87),
    [anon_sym_allow_failure] = ACTIONS(87),
    [anon_sym_expect_contain] = ACTIONS(87),
    [anon_sym_expect_not_contain] = ACTIONS(87),
    [anon_sym_expect_equal] = ACTIONS(87),
    [anon_sym_true] = ACTIONS(87),
    [anon_sym_false] = ACTIONS(87),
    [anon_sym_LBRACE] = ACTIONS(85),
    [anon_sym_RBRACE] = ACTIONS(85),
    [anon_sym_LPAREN] = ACTIONS(85),
    [anon_sym_RPAREN] = ACTIONS(85),
    [anon_sym_LBRACK] = ACTIONS(85),
    [anon_sym_RBRACK] = ACTIONS(85),
    [anon_sym_DOT] = ACTIONS(85),
    [anon_sym_COMMA] = ACTIONS(85),
    [sym_comment] = ACTIONS(85),
    [anon_sym_DASH_GT] = ACTIONS(85),
    [anon_sym_EQ_GT] = ACTIONS(85),
    [anon_sym_EQ_EQ] = ACTIONS(85),
    [anon_sym_BANG_EQ] = ACTIONS(85),
    [anon_sym_EQ_TILDE] = ACTIONS(85),
    [anon_sym_BANG_TILDE] = ACTIONS(85),
    [anon_sym_EQ] = ACTIONS(87),
    [sym_number] = ACTIONS(85),
    [sym_qualified_identifier] = ACTIONS(87),
    [sym_regex] = ACTIONS(85),
    [sym_string] = ACTIONS(87),
    [sym_triple_string] = ACTIONS(85),
    [sym__quote_body] = ACTIONS(87),
    [anon_sym_SQUOTE_SQUOTE_SQUOTE] = ACTIONS(85),
    [sym_tag_word] = ACTIONS(85),
  },
};

static const uint16_t ts_small_parse_table[] = {
  [0] = 2,
    ACTIONS(89), 1,
      anon_sym_SQUOTE_SQUOTE_SQUOTE,
    ACTIONS(91), 1,
      sym_fence_content,
  [7] = 2,
    ACTIONS(57), 1,
      sym__quote_body_immediate,
    ACTIONS(59), 1,
      anon_sym_SQUOTE_SQUOTE_SQUOTE2,
  [14] = 2,
    ACTIONS(93), 1,
      sym__quote_body_immediate,
    ACTIONS(95), 1,
      anon_sym_SQUOTE_SQUOTE_SQUOTE2,
  [21] = 2,
    ACTIONS(97), 1,
      anon_sym_SQUOTE_SQUOTE_SQUOTE,
    ACTIONS(99), 1,
      sym_fence_content,
  [28] = 1,
    ACTIONS(101), 1,
      ts_builtin_sym_end,
  [32] = 1,
    ACTIONS(103), 1,
      anon_sym_SQUOTE_SQUOTE_SQUOTE,
  [36] = 1,
    ACTIONS(105), 1,
      anon_sym_SQUOTE_SQUOTE_SQUOTE,
};

static const uint32_t ts_small_parse_table_map[] = {
  [SMALL_STATE(12)] = 0,
  [SMALL_STATE(13)] = 7,
  [SMALL_STATE(14)] = 14,
  [SMALL_STATE(15)] = 21,
  [SMALL_STATE(16)] = 28,
  [SMALL_STATE(17)] = 32,
  [SMALL_STATE(18)] = 36,
};

static const TSParseActionEntry ts_parse_actions[] = {
  [0] = {.entry = {.count = 0, .reusable = false}},
  [1] = {.entry = {.count = 1, .reusable = false}}, RECOVER(),
  [3] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_source_file, 0, 0, 0),
  [5] = {.entry = {.count = 1, .reusable = false}}, SHIFT(4),
  [7] = {.entry = {.count = 1, .reusable = false}}, SHIFT(2),
  [9] = {.entry = {.count = 1, .reusable = true}}, SHIFT(2),
  [11] = {.entry = {.count = 1, .reusable = true}}, SHIFT(5),
  [13] = {.entry = {.count = 1, .reusable = false}}, SHIFT(5),
  [15] = {.entry = {.count = 1, .reusable = false}}, SHIFT(6),
  [17] = {.entry = {.count = 1, .reusable = true}}, SHIFT(12),
  [19] = {.entry = {.count = 1, .reusable = true}}, SHIFT(13),
  [21] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_source_file, 1, 0, 0),
  [23] = {.entry = {.count = 1, .reusable = false}}, SHIFT(3),
  [25] = {.entry = {.count = 1, .reusable = true}}, SHIFT(3),
  [27] = {.entry = {.count = 1, .reusable = true}}, REDUCE(aux_sym_source_file_repeat1, 2, 0, 0),
  [29] = {.entry = {.count = 2, .reusable = false}}, REDUCE(aux_sym_source_file_repeat1, 2, 0, 0), SHIFT_REPEAT(4),
  [32] = {.entry = {.count = 2, .reusable = false}}, REDUCE(aux_sym_source_file_repeat1, 2, 0, 0), SHIFT_REPEAT(3),
  [35] = {.entry = {.count = 2, .reusable = true}}, REDUCE(aux_sym_source_file_repeat1, 2, 0, 0), SHIFT_REPEAT(3),
  [38] = {.entry = {.count = 2, .reusable = true}}, REDUCE(aux_sym_source_file_repeat1, 2, 0, 0), SHIFT_REPEAT(5),
  [41] = {.entry = {.count = 2, .reusable = false}}, REDUCE(aux_sym_source_file_repeat1, 2, 0, 0), SHIFT_REPEAT(5),
  [44] = {.entry = {.count = 2, .reusable = false}}, REDUCE(aux_sym_source_file_repeat1, 2, 0, 0), SHIFT_REPEAT(6),
  [47] = {.entry = {.count = 2, .reusable = true}}, REDUCE(aux_sym_source_file_repeat1, 2, 0, 0), SHIFT_REPEAT(12),
  [50] = {.entry = {.count = 2, .reusable = true}}, REDUCE(aux_sym_source_file_repeat1, 2, 0, 0), SHIFT_REPEAT(13),
  [53] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym__token, 1, 0, 0),
  [55] = {.entry = {.count = 1, .reusable = false}}, REDUCE(sym__token, 1, 0, 0),
  [57] = {.entry = {.count = 1, .reusable = false}}, REDUCE(sym__script_tag, 1, 0, 1),
  [59] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym__script_tag, 1, 0, 1),
  [61] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_operator, 1, 0, 0),
  [63] = {.entry = {.count = 1, .reusable = false}}, REDUCE(sym_operator, 1, 0, 0),
  [65] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_quote_script, 1, 0, 0),
  [67] = {.entry = {.count = 1, .reusable = false}}, REDUCE(sym_quote_script, 1, 0, 0),
  [69] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_fenced_block, 2, 0, 0),
  [71] = {.entry = {.count = 1, .reusable = false}}, REDUCE(sym_fenced_block, 2, 0, 0),
  [73] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_quote_script, 2, 0, 2),
  [75] = {.entry = {.count = 1, .reusable = false}}, REDUCE(sym_quote_script, 2, 0, 2),
  [77] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_fenced_block, 3, 0, 3),
  [79] = {.entry = {.count = 1, .reusable = false}}, REDUCE(sym_fenced_block, 3, 0, 3),
  [81] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_fenced_block, 3, 0, 2),
  [83] = {.entry = {.count = 1, .reusable = false}}, REDUCE(sym_fenced_block, 3, 0, 2),
  [85] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_fenced_block, 4, 0, 4),
  [87] = {.entry = {.count = 1, .reusable = false}}, REDUCE(sym_fenced_block, 4, 0, 4),
  [89] = {.entry = {.count = 1, .reusable = false}}, SHIFT(7),
  [91] = {.entry = {.count = 1, .reusable = true}}, SHIFT(17),
  [93] = {.entry = {.count = 1, .reusable = false}}, SHIFT(8),
  [95] = {.entry = {.count = 1, .reusable = true}}, SHIFT(15),
  [97] = {.entry = {.count = 1, .reusable = false}}, SHIFT(10),
  [99] = {.entry = {.count = 1, .reusable = true}}, SHIFT(18),
  [101] = {.entry = {.count = 1, .reusable = true}},  ACCEPT_INPUT(),
  [103] = {.entry = {.count = 1, .reusable = true}}, SHIFT(9),
  [105] = {.entry = {.count = 1, .reusable = true}}, SHIFT(11),
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
