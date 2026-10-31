package sh.uterm.qa;

import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@SpringBootApplication
@RestController
public class QaApplication {
    @Value("${spring.profiles.active:default}")
    private String profile;
    @Value("${qa.literal:unset}")
    private String literal;

    public static void main(String[] arguments) {
        SpringApplication.run(QaApplication.class, arguments);
    }

    @GetMapping("/probe")
    public Map<String, String> probe() {
        Map<String, String> result = new LinkedHashMap<>();
        result.put("java", System.getProperty("java.version"));
        result.put("profile", profile);
        result.put("literal", literal);
        result.put("jvm", System.getProperty("qa.jvm", "unset"));
        result.put("environment", System.getenv("JAVA_QA_VALUE"));
        return result;
    }
}
