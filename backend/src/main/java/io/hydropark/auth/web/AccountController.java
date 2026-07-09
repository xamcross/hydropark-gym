package io.hydropark.auth.web;

import io.hydropark.auth.service.AccountService;
import io.hydropark.security.CurrentUser;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * §4.1 account lifecycle under {@code /v1/account}. Unlike {@code /v1/auth/**}, this prefix requires
 * a valid access token (the security chain's {@code anyRequest().authenticated()}); the id is taken
 * from the token, never the body.
 */
@RestController
@RequestMapping("/v1/account")
public class AccountController {

  private final AccountService accounts;

  public AccountController(AccountService accounts) {
    this.accounts = accounts;
  }

  @PostMapping("/delete")
  public AccountService.DeletionJob delete() {
    return accounts.startDeletion(CurrentUser.requireUserId());
  }

  @GetMapping("/delete/{jobId}")
  public AccountService.DeletionJob deletionStatus(@PathVariable String jobId) {
    return accounts.jobStatus(CurrentUser.requireUserId(), jobId);
  }

  @GetMapping("/export")
  public AccountService.AccountExport export() {
    return accounts.export(CurrentUser.requireUserId());
  }
}
