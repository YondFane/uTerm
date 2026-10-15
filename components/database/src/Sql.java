import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;

/** Classifies one bounded statement without interpreting quoted SQL as commands. 对单条有界语句分类，不将引用内容当作命令。 */
final class Sql {
    record Token(String text, boolean word, boolean quoted) { }
    private static final Pattern DOLLAR = Pattern.compile("\\$(?:[\\p{L}_][\\p{L}\\p{N}_]*)?\\$");
    private static final Set<String> UNSAFE = Set.of(("INSERT UPDATE DELETE MERGE REPLACE UPSERT INTO CREATE ALTER DROP TRUNCATE "
        + "GRANT REVOKE CALL EXEC EXECUTE COPY LOAD LOCK UNLOCK SET RESET VACUUM ANALYZE COMMIT ROLLBACK SAVEPOINT RELEASE "
        + "DO HANDLER OUTFILE DUMPFILE FOR").split(" "));

    static List<Token> tokens(String sql, String kind) {
        if (sql.isBlank() || sql.length() > 262144) throw new IllegalArgumentException("DB_INPUT_LIMIT");
        List<Token> tokens = new ArrayList<>();
        int at = 0, depth = 0;
        boolean ended = false;
        while (at < sql.length()) {
            char c = sql.charAt(at);
            if (Character.isWhitespace(c)) { at++; continue; }
            if (sql.startsWith("--", at) && (!kind.equals("mysql") || at + 2 == sql.length() || Character.isWhitespace(sql.charAt(at + 2)))
                    || kind.equals("mysql") && c == '#') {
                int end = sql.indexOf('\n', at);
                at = end < 0 ? sql.length() : end;
                continue;
            }
            if (sql.startsWith("/*", at)) {
                if (sql.startsWith("/*!", at)) fail();
                at += 2;
                int comment = 1;
                while (at < sql.length() && comment > 0) {
                    if (kind.equals("postgresql") && sql.startsWith("/*", at)) { comment++; at += 2; }
                    else if (sql.startsWith("*/", at)) { comment--; at += 2; }
                    else at++;
                    if (comment > 256) fail();
                }
                if (comment > 0) fail();
                continue;
            }
            if (ended) fail();
            int from = at;
            boolean quoted = false, word = false;
            var dollar = kind.equals("postgresql") && c == '$' ? DOLLAR.matcher(sql).region(at, sql.length()) : null;
            if (dollar != null && dollar.lookingAt()) {
                quoted = true;
                String delimiter = dollar.group();
                int end = sql.indexOf(delimiter, dollar.end());
                if (end < 0) fail();
                at = end + delimiter.length();
            } else if (kind.equals("oracle") && (c == 'q' || c == 'Q') && at + 2 < sql.length() && sql.charAt(at + 1) == '\'') {
                quoted = true;
                char delimiter = sql.charAt(at + 2);
                char close = switch (delimiter) { case '[' -> ']'; case '(' -> ')'; case '{' -> '}'; case '<' -> '>'; default -> delimiter; };
                if (Character.isWhitespace(delimiter)) fail();
                int end = sql.indexOf("" + close + '\'', at + 3);
                if (end < 0) fail();
                at = end + 2;
            } else if (c == '\'' || c == '"' || c == '`') {
                quoted = true;
                at++;
                boolean closed = false;
                boolean escape = kind.equals("mysql") || kind.equals("postgresql") && from > 0 && "eE".indexOf(sql.charAt(from - 1)) >= 0;
                while (at < sql.length()) {
                    if (escape && sql.charAt(at) == '\\') at += 2;
                    else if (sql.charAt(at++) == c) {
                        if (at < sql.length() && sql.charAt(at) == c) at++;
                        else { closed = true; break; }
                    }
                }
                if (!closed) fail();
            } else if (Character.isLetterOrDigit(c) || c == '_' || c == '$') {
                word = true;
                while (at < sql.length() && (Character.isLetterOrDigit(sql.charAt(at)) || "_$".indexOf(sql.charAt(at)) >= 0)) at++;
            } else {
                at++;
                if (c == '(') depth++;
                if (c == ')') depth--;
                if (depth < 0 || depth > 256) fail();
                if (c == ';') {
                    if (depth != 0) fail();
                    ended = true;
                    continue;
                }
            }
            tokens.add(new Token(sql.substring(from, at), word, quoted));
            if (tokens.size() > 65536) fail();
        }
        if (depth != 0 || tokens.isEmpty()) fail();
        return tokens;
    }

    static boolean readOnly(String sql, String kind) {
        return readOnly(tokens(sql, kind), kind);
    }

    static boolean readOnly(List<Token> tokens, String kind) {
        String first = tokens.get(0).text().toUpperCase(Locale.ROOT);
        if (!first.equals("SELECT") && !first.equals("WITH")) return false;
        for (int index = 0; index < tokens.size(); index++) {
            Token token = tokens.get(index);
            if (token.word() && UNSAFE.contains(token.text().toUpperCase(Locale.ROOT))) return false;
            if (token.text().equals(":") && index + 1 < tokens.size() && tokens.get(index + 1).text().equals("=")) return false;
            if (kind.equals("mysql") && token.quoted() && (token.text().contains("\\'") || token.text().contains("\\\""))) return false;
        }
        return true;
    }

    private static void fail() { throw new IllegalArgumentException("DB_SQL_UNSUPPORTED"); }
}
