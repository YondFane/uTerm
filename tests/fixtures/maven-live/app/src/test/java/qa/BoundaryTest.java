package qa;

import java.util.Properties;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.assertEquals;

public class BoundaryTest {
    @Test
    void selectedSettingsProfileAndJvmConfigReachTheActualReactor() throws Exception {
        Properties properties = new Properties();
        try (java.io.InputStream input = getClass().getResourceAsStream("/qa.properties")) {
            properties.load(input);
        }
        assertEquals("profile-selected", properties.getProperty("profile"));
        assertEquals("settings-selected", properties.getProperty("settings"));
        assertEquals("jvm-selected", properties.getProperty("jvm"));
        assertEquals("false", properties.getProperty("fail"));
        assertEquals("from-reactor", Library.value());
    }
}
