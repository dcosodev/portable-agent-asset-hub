# GetHealthDefaultResponse


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**error** | [**GetHealthDefaultResponseError**](GetHealthDefaultResponseError.md) |  |
**request_id** | **str** |  |

## Example

```python
from openapi_client.models.get_health_default_response import GetHealthDefaultResponse

# TODO update the JSON string below
json = "{}"
# create an instance of GetHealthDefaultResponse from a JSON string
get_health_default_response_instance = GetHealthDefaultResponse.from_json(json)
# print the JSON string representation of the object
print(GetHealthDefaultResponse.to_json())

# convert the object into a dict
get_health_default_response_dict = get_health_default_response_instance.to_dict()
# create an instance of GetHealthDefaultResponse from a dict
get_health_default_response_from_dict = GetHealthDefaultResponse.from_dict(get_health_default_response_dict)
```
[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
