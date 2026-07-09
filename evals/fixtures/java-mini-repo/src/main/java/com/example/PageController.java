package com.example;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class PageController {
    private final UserService userService = new UserService();

    @GetMapping("/users")
    public String users() {
        return userService.listUsers();
    }
}
