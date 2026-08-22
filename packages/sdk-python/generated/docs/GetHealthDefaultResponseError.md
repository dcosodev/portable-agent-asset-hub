# GetHealthDefaultResponseError


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**code** | **str** |  | 
**message** | **str** |  | 
**status** | **int** |  | 

## Example

```python
from openapi_client.models.get_health_default_response_error import GetHealthDefaultResponseError

# TODO update the JSON string below
json = "{}"
# create an instance of GetHealthDefaultResponseError from a JSON string
get_health_default_response_error_instance = GetHealthDefaultResponseError.from_json(json)
# print the JSON string representation of the object
print(GetHealthDefaultResponseError.to_json())

# convert the object into a dict
get_health_default_response_error_dict = get_health_default_response_error_instance.to_dict()
# create an instance of GetHealthDefaultResponseError from a dict
get_health_default_response_error_from_dict = GetHealthDefaultResponseError.from_dict(get_health_default_response_error_dict)
```
[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)


